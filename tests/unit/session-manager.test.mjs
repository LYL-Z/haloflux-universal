/**
 * Unit tests: packages/session-manager — dedupe, ordering and the timeout
 * ladder from docs/architecture.md §7, without starting a bridge.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { importIfExists, notReady } from '../helpers/env.mjs';
import { event } from '../helpers/events.mjs';

const mod = await importIfExists('packages/session-manager/src/index.mjs');
const skipReason = mod ? false : notReady('packages/session-manager/src/index.mjs is missing');

function makeManager(nowRef, options = {}) {
  return new mod.SessionManager({ clock: () => nowRef.value, ...options });
}

function ev(sessionId, eventType, overrides = {}) {
  return event('generic', sessionId, eventType, overrides);
}

describe('session-manager: state machine', { skip: skipReason }, () => {
  test('applies events and exposes a SessionView snapshot', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      const result = manager.ingest(ev('s1', 'session.start', { timestamp: nowRef.value }));
      assert.equal(result.status, 'applied');
      const snapshot = manager.snapshot();
      assert.equal(snapshot.schemaVersion, 1);
      assert.equal(snapshot.activeSessionId, 's1');
      assert.equal(snapshot.sessions.length, 1);
      const view = snapshot.sessions[0];
      assert.equal(view.sessionId, 's1');
      assert.equal(view.state, 'connected');
      assert.equal(view.reportedState, 'connected');
      assert.equal(view.source, 'host-native');
      assert.equal(view.confidence, 'confirmed');
      assert.equal(view.connected, true);
      assert.equal(view.metrics.model, undefined, 'metrics must never be invented');
      assert.equal(view.metrics.tokensPerSecond, undefined);
    } finally {
      manager.stop();
    }
  });

  test('deduplicates by eventId and counts it', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      const one = ev('s1', 'run.start', { timestamp: nowRef.value });
      assert.equal(manager.ingest(one).status, 'applied');
      assert.equal(manager.ingest(one).status, 'duplicate');
      assert.equal(manager.snapshot().bridge.duplicates, 1);
      assert.equal(manager.snapshot().sessions[0].recentEvents.length, 1);
    } finally {
      manager.stop();
    }
  });

  test('out-of-order events (>5 s older) apply to metrics only, never regress state', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      manager.ingest(ev('s1', 'run.start', { timestamp: nowRef.value }));
      const late = ev('s1', 'tool.fail', { timestamp: nowRef.value - 6000, metadata: { label: 'late' } });
      const result = manager.ingest(late);
      assert.equal(result.status, 'metrics-only');
      const view = manager.snapshot().sessions[0];
      assert.equal(view.state, 'running');
      assert.equal(view.reportedState, 'running');
      assert.ok(view.warnings.includes('out-of-order-event'));
    } finally {
      manager.stop();
    }
  });

  test('sequential tool.start → tool.fail → approval.request → run.end', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      const sequence = [
        ['tool.start', 'tool'],
        ['tool.fail', 'running'],
        ['approval.request', 'waiting_approval'],
        ['run.end', 'idle'],
      ];
      for (const [index, [eventType, expected]] of sequence.entries()) {
        nowRef.value += 1000;
        manager.ingest(ev('s1', eventType, { timestamp: nowRef.value }));
        assert.equal(manager.snapshot().sessions[0].state, expected, `after ${eventType}`);
        assert.equal(manager.snapshot().sessions[0].reportedState, expected);
        assert.ok(index >= 0);
      }
    } finally {
      manager.stop();
    }
  });

  test('timeout ladder: stale tool/running/approval become unknown + warning', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      for (const [eventType, advanceMs, warning] of [
        ['tool.start', 10 * 60 * 1000 + 1, 'stale-tool-timeout'],
        ['run.start', 150 * 1000 + 1, 'stale-running-timeout'],
        ['approval.request', 15 * 60 * 1000 + 1, 'stale-approval-timeout'],
      ]) {
        const sessionId = `timeout-${eventType}`;
        manager.ingest(ev(sessionId, eventType, { timestamp: nowRef.value }));
        nowRef.value += advanceMs;
        manager.tick();
        const view = manager.snapshot().sessions.find((session) => session.sessionId === sessionId);
        assert.equal(view.state, 'unknown', `${eventType} should time out to unknown`);
        assert.equal(view.source, 'derived');
        assert.equal(view.confidence, 'inferred');
        assert.ok(view.warnings.includes(warning), `${eventType} warnings: ${view.warnings.join(',')}`);
      }
    } finally {
      manager.stop();
    }
  });

  test('timeout ladder: idle → connected after 45 s, connected → disconnected after 10 min', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      manager.ingest(ev('s1', 'run.end', { timestamp: nowRef.value }));
      nowRef.value += 45 * 1000;
      manager.tick();
      assert.equal(manager.snapshot().sessions[0].state, 'connected');
      nowRef.value += 10 * 60 * 1000 + 1;
      manager.tick();
      assert.equal(manager.snapshot().sessions[0].state, 'disconnected');
      assert.equal(manager.snapshot().sessions[0].connected, false);
    } finally {
      manager.stop();
    }
  });

  test('keeps at most 200 recent events per session', () => {
    const nowRef = { value: 1_800_000_000_000 };
    const manager = makeManager(nowRef);
    try {
      for (let i = 0; i < 250; i += 1) {
        nowRef.value += 10;
        manager.ingest(ev('s1', 'session.heartbeat', { timestamp: nowRef.value, metadata: { step: i } }));
      }
      assert.equal(manager.snapshot().sessions[0].recentEvents.length, 200);
    } finally {
      manager.stop();
    }
  });
});
