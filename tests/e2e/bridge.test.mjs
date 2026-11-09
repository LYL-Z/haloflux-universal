/**
 * End-to-end: the real bridge process + session manager + SSE.
 * Contract: docs/architecture.md §5, §6, §7, §11.
 *
 * The bridge is spawned on a random 179xx port with an isolated HALOFLUX_HOME.
 * Never uses 17817. When the bridge is not implemented yet the suite is skipped
 * as NOT_READY (never silently passed).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeImplemented,
  connectSse,
  startBridge,
} from '../helpers/bridge.mjs';
import { notReady } from '../helpers/env.mjs';
import { event, agentLoop } from '../helpers/events.mjs';

const implemented = bridgeImplemented();
const skipReason = implemented ? false : notReady('packages/event-bridge/src/server.mjs is missing');

describe('bridge e2e: real process on a random port', { skip: skipReason }, () => {
  /** @type {Awaited<ReturnType<typeof startBridge>>} */
  let bridge;
  let sessionSeq = 0;

  before(async () => {
    bridge = await startBridge();
  });

  after(async () => {
    await bridge?.stop();
  });

  function newSession(name = 'e2e') {
    sessionSeq += 1;
    return `sess-${name}-${sessionSeq}-${Date.now().toString(36)}`;
  }

  async function findSession(sessionId, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await bridge.state();
      const found = (state.sessions ?? []).find((session) => session.sessionId === sessionId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const state = await bridge.state();
    throw new Error(`session ${sessionId} not found in state: ${JSON.stringify(state.sessions ?? [])}`);
  }

  async function postOne(input) {
    const res = await bridge.post('/v1/events', input);
    assert.equal(res.status, 202, `POST /v1/events expected 202, got ${res.status}: ${res.text}`);
    assert.ok(res.json, `POST /v1/events must return JSON: ${res.text}`);
    return res.json;
  }

  test('GET /v1/health is unauthenticated and reports the bridge', async () => {
    const res = await fetch(`${bridge.base}/v1/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(typeof json.name, 'string');
    assert.equal(typeof json.version, 'string');
    assert.ok(Number.isFinite(json.uptimeMs));
    void bridge.health;
  });

  test('initial /v1/state is a full snapshot with empty sessions', async () => {
    const state = await bridge.state();
    assert.equal(state.schemaVersion, 1);
    assert.ok(Array.isArray(state.sessions));
    assert.ok(Array.isArray(state.hosts));
    assert.equal(typeof state.bridge, 'object');
    assert.equal(typeof state.bridge.eventCount, 'number');
    assert.equal(typeof state.bridge.dropped, 'number');
    assert.equal(state.bridge.dropped, 0);
    assert.ok(state.sessions.length === 0, `fresh bridge should have no sessions, got ${state.sessions.length}`);
  });

  test('POST single event → 202, appears in /v1/state as a SessionView', async () => {
    const sessionId = newSession('single');
    const start = event('claude-code', sessionId, 'session.start', { hostVersion: '2.1.299', metadata: { projectName: 'haloflux' } });
    const response = await postOne(start);
    assert.equal(response.accepted, 1);
    assert.equal(response.duplicates, 0);
    assert.ok(response.sessions >= 1);

    const view = await findSession(sessionId);
    assert.equal(view.sessionId, sessionId);
    assert.equal(view.host, 'claude-code');
    assert.equal(view.hostVersion, '2.1.299');
    assert.equal(view.state, 'connected');
    assert.equal(view.reportedState, 'connected');
    assert.equal(view.source, 'host-native');
    assert.equal(view.confidence, 'confirmed');
    assert.equal(view.connected, true);
    assert.equal(typeof view.lastEventAt, 'number');
    assert.equal(typeof view.startedAt, 'number');
    assert.ok(Array.isArray(view.recentEvents));
    assert.equal(view.metrics.projectName, 'haloflux');
    assert.equal(view.metrics.model, undefined, 'never invent metrics the host did not report');
    assert.ok(Array.isArray(view.warnings));
    assert.equal(view.recentEvents.at(-1).eventType, 'session.start');
  });

  test('canonical loop tool.start → tool.fail → approval.request → run.end drives /v1/state', async () => {
    const sessionId = newSession('loop');
    const events = agentLoop({ host: 'codex', sessionId });
    const expectedStates = [
      'connected', // session.start
      'running', // task.received
      'running', // run.start
      'tool', // tool.start
      'running', // tool.fail
      'waiting_approval', // approval.request
      'idle', // run.end
    ];

    for (const [index, current] of events.entries()) {
      const response = await postOne(current);
      assert.equal(response.accepted, 1, `event ${current.eventType} not accepted: ${JSON.stringify(response)}`);
      const view = await findSession(sessionId);
      assert.equal(
        view.state,
        expectedStates[index],
        `after ${current.eventType} expected state ${expectedStates[index]}, got ${view.state}`,
      );
      assert.equal(view.reportedState, expectedStates[index], `reportedState after ${current.eventType}`);
      assert.equal(view.source, 'host-native');
      assert.equal(view.confidence, 'confirmed');
    }

    const finalView = await findSession(sessionId);
    assert.equal(finalView.state, 'idle');
    assert.equal(finalView.connected, true);
    const types = finalView.recentEvents.map((recent) => recent.eventType);
    for (const required of ['tool.start', 'tool.fail', 'approval.request', 'run.end']) {
      assert.ok(types.includes(required), `recentEvents missing ${required}: ${types.join(',')}`);
    }
    assert.equal(finalView.metrics.toolName, 'Read');
  });

  test('duplicate eventId is counted, not re-applied', async () => {
    const sessionId = newSession('dup');
    const first = event('cursor', sessionId, 'run.start', { metadata: { label: 'first' } });
    const response1 = await postOne(first);
    assert.equal(response1.accepted, 1);
    const response2 = await postOne(first);
    assert.equal(response2.accepted, 0, `duplicate must not be accepted: ${JSON.stringify(response2)}`);
    assert.equal(response2.duplicates, 1);
    const view = await findSession(sessionId);
    assert.equal(view.state, 'running');
    assert.equal(view.recentEvents.filter((recent) => recent.eventType === 'run.start').length, 1);
  });

  test('batch POST {events:[…]} is accepted atomically', async () => {
    const sessionId = newSession('batch');
    const events = [
      event('workbuddy', sessionId, 'session.start', { timestamp: Date.now() }),
      event('workbuddy', sessionId, 'task.received', { timestamp: Date.now() + 1 }),
      event('workbuddy', sessionId, 'run.start', { timestamp: Date.now() + 2 }),
    ];
    const res = await bridge.post('/v1/events', { events });
    assert.equal(res.status, 202, `batch POST expected 202: ${res.status} ${res.text}`);
    assert.equal(res.json.accepted, 3);
    const view = await findSession(sessionId);
    assert.equal(view.state, 'running');
    assert.equal(view.host, 'workbuddy');
  });

  test('invalid event is rejected with 400 and issue paths', async () => {
    const sessionId = newSession('invalid');
    const invalid = { ...event('trae', sessionId, 'run.start'), host: 'not-a-host', metadata: { prompt: 'leak' } };
    const res = await bridge.post('/v1/events', invalid);
    assert.equal(res.status, 400, `invalid event expected 400, got ${res.status}: ${res.text}`);
    assert.ok(Array.isArray(res.json?.issues), `400 body should carry issues: ${res.text}`);
    assert.ok(res.json.issues.some((issue) => String(issue.path).includes('host')));
    assert.ok(res.json.issues.some((issue) => String(issue.path).includes('metadata.prompt')));
    const state = await bridge.state();
    assert.ok(!(state.sessions ?? []).some((session) => session.sessionId === sessionId), 'invalid event must not create a session');
  });

  test('batch over 100 events is rejected', async () => {
    const events = Array.from({ length: 101 }, (_, index) =>
      event('generic', newSession('over'), 'session.heartbeat', { timestamp: Date.now() + index }),
    );
    const res = await bridge.post('/v1/events', { events });
    assert.ok([400, 413].includes(res.status), `over-limit batch expected 400/413, got ${res.status}: ${res.text}`);
  });

  test('SSE: snapshot first, then update with final state and recent events', async () => {
    const sse = await connectSse(bridge.base, bridge.token);
    try {
      assert.equal(sse.res.status, 200);
      assert.match(sse.res.headers.get('content-type') ?? '', /text\/event-stream/);
      const first = await sse.next(5000);
      assert.ok(first, 'no SSE frame received (expected snapshot)');
      assert.equal(first.event, 'snapshot', 'first SSE frame must be snapshot');
      assert.equal(first.json.schemaVersion, 1);
      assert.ok(Array.isArray(first.json.sessions));
      assert.equal(typeof first.json.bridge.eventCount, 'number');

      const sessionId = newSession('sse');
      const updates = [];
      for (const current of [
        event('deepseek-harness', sessionId, 'session.start', { timestamp: Date.now() }),
        event('deepseek-harness', sessionId, 'task.received', { timestamp: Date.now() + 30 }),
        event('deepseek-harness', sessionId, 'run.start', { timestamp: Date.now() + 60 }),
        event('deepseek-harness', sessionId, 'tool.start', { timestamp: Date.now() + 90, metadata: { toolName: 'Bash' } }),
        event('deepseek-harness', sessionId, 'approval.request', { timestamp: Date.now() + 120 }),
        event('deepseek-harness', sessionId, 'run.end', { timestamp: Date.now() + 1500 }),
      ]) {
        // Space the posts so the >=250 ms update throttle produces frames.
        await new Promise((resolve) => setTimeout(resolve, 320));
        const res = await bridge.post('/v1/events', current);
        assert.equal(res.status, 202, `SSE feed POST failed: ${res.status} ${res.text}`);
      }

      const deadline = Date.now() + 6000;
      let finalView;
      while (Date.now() < deadline) {
        const frame = await sse.next(1500);
        if (!frame) continue;
        assert.equal(frame.event, 'update', `unexpected SSE event ${frame.event}`);
        updates.push(frame.json);
        const found = (frame.json.sessions ?? []).find((session) => session.sessionId === sessionId);
        if (found?.state === 'idle') {
          finalView = found;
          break;
        }
      }
      assert.ok(updates.length >= 1, 'no update frame received after posting events');
      assert.ok(finalView, `no update showed the final idle session; last=${JSON.stringify(updates.at(-1)?.sessions?.find((s) => s.sessionId === sessionId))}`);
      assert.equal(finalView.source, 'host-native');
      assert.equal(finalView.metrics.toolName, 'Bash');
      assert.ok(finalView.recentEvents.some((recent) => recent.eventType === 'approval.request'));
    } finally {
      await sse.close();
    }
  });

  test('GET /v1/settings returns a settings object (defaults)', async () => {
    const res = await bridge.get('/v1/settings');
    assert.equal(res.status, 200, `GET /v1/settings failed: ${res.status} ${res.text}`);
    assert.equal(typeof res.json, 'object');
    assert.equal(res.json.schemaVersion, 1);
    assert.equal(typeof res.json.preset, 'string');
    assert.equal(typeof res.json.visual, 'object');
    assert.equal(typeof res.json.bridge, 'object');
  });

  test('PUT /v1/settings round-trips the document', async () => {
    const current = await bridge.get('/v1/settings');
    assert.equal(current.status, 200);
    const next = { ...current.json, visual: { ...current.json.visual, opacity: 0.42 } };
    const res = await fetch(`${bridge.base}/v1/settings`, {
      method: 'PUT',
      headers: { ...bridge.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(next),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200, `PUT /v1/settings failed: ${res.status} ${await res.text()}`);
    const saved = await bridge.get('/v1/settings');
    assert.equal(saved.json.visual.opacity, 0.42);
  });
});
