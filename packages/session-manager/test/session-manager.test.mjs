import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEvent } from '../../event-schema/dist/index.js';
import { SessionManager } from '../src/index.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-session-test-'));
}

function event(overrides = {}) {
  const timestamp = overrides.timestamp ?? 1_000_000;
  return createEvent({
    host: 'claude-code',
    hostVersion: '2.1.299',
    sessionId: 'claude-code:session-a',
    eventType: 'run.start',
    timestamp,
    eventId: overrides.eventId || `evt-${Math.random().toString(36).slice(2, 12)}`,
    ...overrides,
  });
}

function makeManager(options = {}) {
  let now = options.now ?? 1_000_000;
  const clock = () => now;
  const manager = new SessionManager({ clock, capabilitiesDir: null, ...options });
  return {
    manager,
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
      return now;
    },
  };
}

test('dedupe: repeated eventId is counted but not applied', () => {
  const { manager } = makeManager();
  const first = event({ eventId: 'evt-dedupe-0001', eventType: 'run.start' });
  assert.equal(manager.ingest(first).status, 'applied');
  const duplicate = manager.ingest(first);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.duplicate, true);

  const snapshot = manager.snapshot();
  assert.equal(snapshot.bridge.eventCount, 1);
  assert.equal(snapshot.bridge.duplicates, 1);
  assert.equal(snapshot.sessions[0].recentEvents.length, 1);
});

test('out-of-order event older than 5 s only updates metrics and never regresses state', () => {
  const { manager } = makeManager();
  manager.ingest(
    event({ eventId: 'evt-order-0001', eventType: 'run.start', timestamp: 1_000_000 }),
  );
  assert.equal(manager.snapshot().sessions[0].state, 'running');

  const stale = event({
    eventId: 'evt-order-0002',
    eventType: 'approval.request',
    state: 'waiting_approval',
    timestamp: 1_000_000 - 6000,
    metadata: { tokenCount: 42 },
  });
  const result = manager.ingest(stale);
  assert.equal(result.status, 'metrics-only');

  const session = manager.snapshot().sessions[0];
  assert.equal(session.state, 'running');
  assert.equal(session.reportedState, 'running');
  assert.equal(session.source, 'host-native');
  assert.equal(session.confidence, 'confirmed');
  assert.equal(session.metrics.tokenCount, 42);
  assert.ok(session.warnings.includes('out-of-order-event'));
});

test('an event only 2 s older is applied in arrival order', () => {
  const { manager } = makeManager();
  manager.ingest(event({ eventId: 'evt-order-0003', eventType: 'run.start', timestamp: 1_000_000 }));
  manager.ingest(
    event({
      eventId: 'evt-order-0004',
      eventType: 'approval.request',
      state: 'waiting_approval',
      timestamp: 998_000,
    }),
  );
  assert.equal(manager.snapshot().sessions[0].state, 'waiting_approval');
});

test('timeout ladder: idle -> connected at 45 s, then disconnected after 10 min', () => {
  const ctx = makeManager();
  ctx.manager.ingest(event({ eventId: 'evt-idle-0001', eventType: 'run.end', state: 'idle', timestamp: 1_000_000 }));

  ctx.advance(45 * 1000 + 1000);
  assert.equal(ctx.manager.tick(), true);
  let session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'connected');
  assert.equal(session.source, 'derived');
  assert.equal(session.confidence, 'inferred');
  assert.ok(session.warnings.includes('auto-connected'));

  ctx.advance(10 * 60 * 1000);
  assert.equal(ctx.manager.tick(), true);
  session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'disconnected');
  assert.ok(session.warnings.includes('auto-disconnected'));
});

test('timeout ladder: running/output stale after 150 s -> unknown + warning', () => {
  const ctx = makeManager();
  ctx.manager.ingest(event({ eventId: 'evt-run-0001', eventType: 'run.start', state: 'running', timestamp: 1_000_000 }));
  ctx.advance(150 * 1000 + 1000);
  assert.equal(ctx.manager.tick(), true);
  const session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'unknown');
  assert.ok(session.warnings.includes('stale-running-timeout'));

  const output = makeManager();
  output.manager.ingest(
    event({ eventId: 'evt-out-0001', eventType: 'output.start', state: 'output', timestamp: 1_000_000 }),
  );
  output.advance(150 * 1000 + 1000);
  assert.equal(output.manager.tick(), true);
  assert.equal(output.manager.snapshot().sessions[0].state, 'unknown');
});

test('timeout ladder: tool stale after 10 min -> unknown + warning; fresh tool stays', () => {
  const ctx = makeManager();
  ctx.manager.ingest(event({ eventId: 'evt-tool-0001', eventType: 'tool.start', state: 'tool', timestamp: 1_000_000 }));
  ctx.advance(60 * 1000);
  assert.equal(ctx.manager.tick(), false);
  assert.equal(ctx.manager.snapshot().sessions[0].state, 'tool');

  ctx.advance(10 * 60 * 1000);
  assert.equal(ctx.manager.tick(), true);
  const session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'unknown');
  assert.ok(session.warnings.includes('stale-tool-timeout'));
});

test('timeout ladder: waiting_approval stale after 15 min -> unknown + warning', () => {
  const ctx = makeManager();
  ctx.manager.ingest(
    event({ eventId: 'evt-appr-0001', eventType: 'approval.request', state: 'waiting_approval', timestamp: 1_000_000 }),
  );
  ctx.advance(15 * 60 * 1000 + 1000);
  assert.equal(ctx.manager.tick(), true);
  const session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'unknown');
  assert.ok(session.warnings.includes('stale-approval-timeout'));
});

test('timeout ladder: connected session unseen 10 min -> disconnected', () => {
  const ctx = makeManager();
  ctx.manager.ingest(
    event({ eventId: 'evt-conn-0001', eventType: 'session.start', state: 'connected', timestamp: 1_000_000 }),
  );
  ctx.advance(10 * 60 * 1000 + 1000);
  assert.equal(ctx.manager.tick(), true);
  const session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'disconnected');
  assert.equal(session.connected, false);
});

test('a running session is not downgraded to connected at 46 s', () => {
  const ctx = makeManager();
  ctx.manager.ingest(event({ eventId: 'evt-run-0002', eventType: 'run.start', state: 'running', timestamp: 1_000_000 }));
  ctx.advance(46 * 1000);
  ctx.manager.tick();
  assert.equal(ctx.manager.snapshot().sessions[0].state, 'running');
});

test('multi-session isolation: state, metrics and hosts stay per session', () => {
  const ctx = makeManager();
  ctx.manager.ingest(
    event({
      eventId: 'evt-multi-0001',
      host: 'claude-code',
      sessionId: 'claude-code:a',
      eventType: 'run.start',
      state: 'running',
      metadata: { tokenCount: 10, model: 'claude-x' },
    }),
  );
  ctx.manager.ingest(
    event({
      eventId: 'evt-multi-0002',
      host: 'codex',
      sessionId: 'codex:b',
      eventType: 'tool.start',
      state: 'tool',
      metadata: { toolName: 'Bash' },
    }),
  );
  ctx.manager.ingest(
    event({
      eventId: 'evt-multi-0003',
      host: 'claude-code',
      sessionId: 'claude-code:a',
      eventType: 'run.end',
      state: 'idle',
    }),
  );

  const snapshot = ctx.manager.snapshot();
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.hosts.length, 2);
  const a = snapshot.sessions.find((session) => session.sessionId === 'claude-code:a');
  const b = snapshot.sessions.find((session) => session.sessionId === 'codex:b');
  assert.equal(a.state, 'idle');
  assert.equal(a.metrics.tokenCount, 10);
  assert.equal(a.metrics.model, 'claude-x');
  assert.equal(b.state, 'tool');
  assert.equal(b.metrics.toolName, 'Bash');
  assert.equal(b.metrics.tokenCount, undefined);
  assert.equal(snapshot.activeSessionId, 'claude-code:a');
  assert.ok(snapshot.bridge.version.length > 0);
});

test('metrics are aggregated per sessionId: a later event in another session cannot overwrite step/turn', () => {
  const { manager } = makeManager();
  manager.ingest(
    event({
      eventId: 'evt-metrics-a1',
      host: 'deepseek-harness',
      sessionId: 'dsh:session-a',
      eventType: 'run.start',
      state: 'running',
      timestamp: 1_000_000,
      metadata: { step: 14, turn: 2, contextUsed: 349_300, contextLimit: 1_000_000, model: 'model-a' },
    }),
  );
  manager.ingest(
    event({
      eventId: 'evt-metrics-b1',
      host: 'deepseek-harness',
      sessionId: 'dsh:session-b',
      eventType: 'run.start',
      state: 'running',
      timestamp: 1_000_001,
      metadata: { step: 1, turn: 1, model: 'model-b' },
    }),
  );
  manager.ingest(
    event({
      eventId: 'evt-metrics-b2',
      host: 'deepseek-harness',
      sessionId: 'dsh:session-b',
      eventType: 'tool.start',
      state: 'tool',
      timestamp: 1_000_002,
      metadata: { toolName: 'pwsh', step: 2 },
    }),
  );
  manager.ingest(
    event({
      eventId: 'evt-metrics-a2',
      host: 'deepseek-harness',
      sessionId: 'dsh:session-a',
      eventType: 'output.chunk',
      state: 'output',
      timestamp: 1_000_003,
      metadata: { step: 15, turn: 3 },
    }),
  );

  const snapshot = manager.snapshot();
  const a = snapshot.sessions.find((session) => session.sessionId === 'dsh:session-a');
  const b = snapshot.sessions.find((session) => session.sessionId === 'dsh:session-b');
  assert.equal(a.metrics.step, 15);
  assert.equal(a.metrics.turn, 3);
  assert.equal(a.metrics.model, 'model-a');
  assert.equal(a.metrics.contextUsed, 349_300);
  assert.equal(b.metrics.step, 2);
  assert.equal(b.metrics.turn, 1);
  assert.equal(b.metrics.model, 'model-b');
  assert.equal(b.metrics.toolName, 'pwsh');
  assert.equal(b.metrics.contextUsed, undefined, 'session B never reported contextUsed');
  // Each event mutated only its own session record.
  assert.notEqual(a.metrics, b.metrics);
});

test('capabilities default to all false with warnings when no adapter file exists', () => {
  const dir = tempDir();
  try {
    const manager = new SessionManager({ clock: () => 1_000_000, capabilitiesDir: dir });
    manager.ingest(event({ eventId: 'evt-caps-0001', host: 'codex', sessionId: 'codex:caps' }));
    const snapshot = manager.snapshot();
    const host = snapshot.hosts[0];
    assert.equal(host.host, 'codex');
    assert.deepEqual(host.capabilities, {
      sessionStart: false,
      toolUse: false,
      tokenMetrics: false,
      approval: false,
      outputStream: false,
    });
    assert.equal(host.capabilitiesSource, 'default');
    assert.ok(host.warnings.some((warning) => warning.startsWith('capabilities-default:codex')));
    assert.ok(snapshot.sessions[0].warnings.includes('capabilities-default:codex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capabilities are merged from adapters/<host>/capabilities.json (flat or nested)', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'codex', 'capabilities.json'),
      JSON.stringify({ sessionStart: true, toolUse: true, tokenMetrics: false, approval: true, outputStream: false }),
    );
    fs.mkdirSync(path.join(dir, 'cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cursor', 'capabilities.json'),
      JSON.stringify({ capabilities: { sessionStart: true, toolUse: false, tokenMetrics: true, approval: false, outputStream: true } }),
    );

    const manager = new SessionManager({ clock: () => 1_000_000, capabilitiesDir: dir });
    manager.ingest(event({ eventId: 'evt-caps-0002', host: 'codex', sessionId: 'codex:caps' }));
    manager.ingest(event({ eventId: 'evt-caps-0003', host: 'cursor', sessionId: 'cursor:caps' }));
    const hosts = manager.snapshot().hosts;
    const codex = hosts.find((host) => host.host === 'codex');
    const cursor = hosts.find((host) => host.host === 'cursor');
    assert.equal(codex.capabilitiesSource, 'adapter');
    assert.deepEqual(codex.warnings, []);
    assert.deepEqual(codex.capabilities, {
      sessionStart: true,
      toolUse: true,
      tokenMetrics: false,
      approval: true,
      outputStream: false,
    });
    assert.deepEqual(cursor.capabilities, {
      sessionStart: true,
      toolUse: false,
      tokenMetrics: true,
      approval: false,
      outputStream: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recentEvents ring is capped and dropped events are counted', () => {
  const ctx = makeManager({ config: { recentEventsLimit: 5 } });
  for (let index = 0; index < 8; index += 1) {
    ctx.manager.ingest(
      event({
        eventId: `evt-recent-${String(index).padStart(4, '0')}`,
        eventType: index % 2 === 0 ? 'run.start' : 'run.end',
        state: index % 2 === 0 ? 'running' : 'idle',
      }),
    );
  }
  const snapshot = ctx.manager.snapshot();
  assert.equal(snapshot.sessions[0].recentEvents.length, 5);
  assert.equal(snapshot.bridge.dropped, 3);
});

test('metrics are never invented: missing metadata stays absent from the SessionView', () => {
  const { manager } = makeManager();
  manager.ingest(event({ eventId: 'evt-metrics-0001', metadata: {} }));
  const session = manager.snapshot().sessions[0];
  assert.deepEqual(session.metrics, {});
  assert.equal(JSON.stringify(session).includes('tokensPerSecond'), false);
  assert.equal(JSON.stringify(session).includes('contextUsed'), false);
});

test('timeout-derived states keep reportedState literal and add warnings', () => {
  const ctx = makeManager();
  ctx.manager.ingest(event({ eventId: 'evt-rep-0001', eventType: 'tool.start', state: 'tool', timestamp: 1_000_000 }));
  ctx.advance(10 * 60 * 1000 + 1);
  ctx.manager.tick();
  const session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.reportedState, 'tool');
  assert.equal(session.state, 'unknown');
  assert.equal(session.source, 'derived');
  assert.equal(session.confidence, 'inferred');
});

test('SessionView exposes exactly the contract fields and host shape', () => {
  const { manager } = makeManager();
  manager.ingest(
    event({
      eventId: 'evt-shape-0001',
      host: 'cursor',
      hostVersion: '3.29.9',
      sessionId: 'cursor:shape',
      eventType: 'task.received',
      state: 'running',
      metadata: { sessionTitle: 'Shape test', turn: 1 },
    }),
  );
  const snapshot = manager.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['activeSessionId', 'bridge', 'hosts', 'schemaVersion', 'serverTime', 'sessions']);
  assert.deepEqual(
    Object.keys(snapshot.sessions[0]).sort(),
    [
      'confidence',
      'connected',
      'host',
      'hostVersion',
      'lastEventAt',
      'metrics',
      'recentEvents',
      'reportedState',
      'sessionId',
      'source',
      'startedAt',
      'state',
      'warnings',
    ].sort(),
  );
  assert.equal(snapshot.hosts[0].hostVersion, '3.29.9');
  assert.equal(snapshot.hosts[0].connected, true);
  assert.equal(snapshot.sessions[0].lastEventAt, 1_000_000);
  assert.equal(snapshot.sessions[0].startedAt, 1_000_000);
  assert.deepEqual(snapshot.sessions[0].recentEvents[0], {
    eventType: 'task.received',
    timestamp: 1_000_000,
  });
});

test('session.end sets connected=false; heartbeat is unknown and does not crash', () => {
  const ctx = makeManager();
  ctx.manager.ingest(event({ eventId: 'evt-end-0001', eventType: 'session.heartbeat', state: 'unknown' }));
  ctx.manager.ingest(event({ eventId: 'evt-end-0002', eventType: 'session.end', state: 'disconnected' }));
  const session = ctx.manager.snapshot().sessions[0];
  assert.equal(session.state, 'disconnected');
  assert.equal(session.connected, false);
  assert.equal(ctx.manager.snapshot().hosts[0].connected, false);
});

test('subscribers are notified on ingest and unsubscribing stops notifications', () => {
  const { manager } = makeManager();
  let calls = 0;
  const unsubscribe = manager.subscribe(() => {
    calls += 1;
  });
  manager.ingest(event({ eventId: 'evt-sub-0001' }));
  assert.ok(calls >= 1);
  const before = calls;
  unsubscribe();
  manager.ingest(event({ eventId: 'evt-sub-0002' }));
  assert.equal(calls, before);
});

test('dedupe ring evicts old ids after its configured capacity', () => {
  const { manager } = makeManager({ config: { dedupeRingSize: 2 } });
  const e1 = event({ eventId: 'evt-ring-0001' });
  const e2 = event({ eventId: 'evt-ring-0002' });
  const e3 = event({ eventId: 'evt-ring-0003' });
  manager.ingest(e1);
  manager.ingest(e2);
  manager.ingest(e3);
  // e1 has been evicted from the 2-entry ring and is accepted again.
  assert.equal(manager.ingest(e1).status, 'applied');
});
