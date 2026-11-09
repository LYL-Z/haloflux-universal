import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, createEvent } from '../../packages/event-schema/dist/index.js';
import { SessionManager } from '../../packages/session-manager/src/index.mjs';
import { projectMonitor } from '../../apps/companion/renderer/monitor-projection.mjs';

const base = {
  schemaVersion: 1,
  eventId: 'corr-event-0001',
  timestamp: 1000,
  host: 'deepseek-harness',
  hostVersion: '0.2.1-rc.5',
  sessionId: 'corr-session',
  eventType: 'tool.start',
  state: 'tool',
  source: 'host-native',
  confidence: 'confirmed',
  metadata: { toolName: 'Bash', toolCallId: 'call-abc' },
};

test('schema accepts optional toolCallId/runId and rejects oversized ids', () => {
  assert.equal(validateEvent(base).ok, true);
  assert.equal(validateEvent({ ...base, metadata: { ...base.metadata, runId: 'run-1' } }).ok, true);
  assert.equal(validateEvent({ ...base, metadata: { ...base.metadata, toolCallId: 'x'.repeat(65) } }).ok, false);
  assert.equal(validateEvent({ ...base, metadata: { ...base.metadata, toolCallId: 42 } }).ok, false);
});

test('session manager computes tool duration only from a matched toolCallId', () => {
  const manager = new SessionManager({ clock: () => 2000 });
  const start = createEvent({ host: 'deepseek-harness', hostVersion: '0.2.1-rc.5', sessionId: 'corr-session', eventType: 'tool.start', timestamp: 1000, metadata: { toolName: 'Bash', toolCallId: 'call-abc' } });
  const end = createEvent({ host: 'deepseek-harness', hostVersion: '0.2.1-rc.5', sessionId: 'corr-session', eventType: 'tool.end', timestamp: 1600, metadata: { toolName: 'Bash', toolCallId: 'call-abc' } });
  manager.ingest(start);
  manager.ingest(end);
  const view = manager.snapshot(2000).sessions[0];
  assert.equal(view.metrics.lastToolCallId, 'call-abc');
  assert.equal(view.metrics.lastToolDurationMs, 600);
  assert.equal(view.metrics.lastToolCorrelated, true);

  const manager2 = new SessionManager({ clock: () => 2000 });
  manager2.ingest(createEvent({ host: 'codex', hostVersion: '0.154.0', sessionId: 'corr-2', eventType: 'tool.end', timestamp: 1600, metadata: { toolName: 'Bash', toolCallId: 'call-xyz' } }));
  const view2 = manager2.snapshot(2000).sessions[0];
  assert.equal(view2.metrics.lastToolDurationMs, undefined);
  assert.equal(view2.metrics.lastToolCorrelated, false);
});

test('derived heartbeat never downgrades a host-native confirmed session', () => {
  const manager = new SessionManager({ clock: () => 5000 });
  manager.ingest(createEvent({
    host: 'deepseek-harness', hostVersion: '0.2.1-rc.5', sessionId: 'provenance-1',
    eventType: 'tool.start', timestamp: 1000, source: 'host-native', confidence: 'confirmed',
    metadata: { toolName: 'Bash' },
  }));
  manager.ingest(createEvent({
    host: 'deepseek-harness', hostVersion: '0.2.1-rc.5', sessionId: 'provenance-1',
    eventType: 'session.heartbeat', timestamp: 2000, source: 'derived', confidence: 'inferred',
    state: 'unknown', metadata: {},
  }));
  const view = manager.snapshot(5000).sessions[0];
  assert.equal(view.source, 'host-native');
  assert.equal(view.confidence, 'confirmed');
  // State itself still follows the newest event; provenance does not lie.
  assert.equal(view.state, 'unknown');
});

test('projection surfaces real duration and correlation, never invents them', () => {
  const projection = projectMonitor({
    hosts: [{ id: 'deepseek-harness', short: 'DS' }],
    selectedSessionId: 's1',
    sessions: [{ sessionId: 's1', host: 'deepseek-harness', metrics: {}, warnings: [] }],
    events: [
      { eventType: 'tool.start', timestamp: 1000, toolName: 'Bash', toolCallId: 'call-1' },
      { eventType: 'tool.end', timestamp: 1450, toolName: 'Bash', toolCallId: 'call-1', durationMs: 450 },
    ],
  });
  assert.equal(projection.toolDurationMs, 450);
  assert.equal(projection.toolCorrelated, true);

  const uncorrelated = projectMonitor({
    hosts: [{ id: 'codex', short: 'CX' }],
    selectedSessionId: 's2',
    sessions: [{ sessionId: 's2', host: 'codex', metrics: {}, warnings: [] }],
    events: [{ eventType: 'tool.end', timestamp: 1450, toolName: 'Read' }],
  });
  assert.equal(uncorrelated.toolDurationMs, null);
  assert.equal(uncorrelated.toolCorrelated, false);
});
