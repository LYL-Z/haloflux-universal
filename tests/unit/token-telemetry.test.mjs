import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTokenTelemetry } from '../../apps/companion/renderer/token-telemetry.mjs';

const sessions = [{ sessionId: 's1' }];
const event = (id, meta, extra = {}) => ({ eventId: id, sessionId: 's1', timestamp: 1, host: 'deepseek-harness', source: 'host-native', confidence: 'confirmed', eventType: 'output.end', metadata: meta, ...extra });

test('token telemetry only sums explicit host tokenCount and keeps missing fields unavailable', () => {
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events: [event('a', { tokenCount: 10 }), event('b', { tokenCount: 5, contextUsed: 100, contextLimit: 1000, model: 'm' })] });
  assert.equal(result.field.outputTokens.value, 15);
  assert.equal(result.field.outputTokens.status, 'HOST_REPORTED/DERIVED_SUM');
  assert.equal(result.field.inputTokens.value, null);
  assert.equal(result.field.cachedTokens.value, null);
  assert.equal(result.field.reasoningTokens.value, null);
  assert.equal(result.field.contextUsed.value, 100);
  assert.equal(result.field.contextLimit.value, 1000);
  assert.equal(result.field.requestId.status, 'UNAVAILABLE');
});

test('token telemetry does not infer tokens from event count, tool count or text length', () => {
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events: [event('a', { toolName: 'Bash', output: 'x'.repeat(5000) }), event('b', { toolCallId: 'c1' })] });
  assert.equal(result.field.outputTokens.value, null);
  assert.equal(result.available, false);
});

test('token telemetry dedupes eventId and never counts contextUsed as output tokens', () => {
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events: [event('a', { tokenCount: 7, contextUsed: 5000 }), event('a', { tokenCount: 7, contextUsed: 5000 })] });
  assert.equal(result.field.outputTokens.value, 7);
  assert.equal(result.samples.length, 1);
  assert.equal(result.field.contextUsed.value, 5000);
});

test('heartbeat/run totals are not summed as output tokens', () => {
  const events = [
    { ...event('h', { tokenCount: 9000 }), eventType: 'session.heartbeat', source: 'derived' },
    { ...event('r', { tokenCount: 40 }), eventType: 'run.end' },
    event('o1', { tokenCount: 10 }),
    event('o2', { tokenCount: 12 }),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.outputTokens.value, 22);
  assert.equal(result.samples.length, 2);
  assert.equal(result.field.outputTokens.value !== 9052, true);
  assert.equal(result.field.contextUsed.value, null);
});

test('session metric fallback provides context snapshots without inventing output', () => {
  const result = buildTokenTelemetry({
    sessions: [{ sessionId: 's1', metrics: { contextUsed: 1200, contextLimit: 2000, model: 'm' } }],
    selectedSessionId: 's1',
    events: [],
  });
  assert.equal(result.field.contextUsed.value, 1200);
  assert.equal(result.field.contextLimit.value, 2000);
  assert.equal(result.field.outputTokens.value, null);
  assert.equal(result.available, true);
});

test('simulated samples remain flagged and empty telemetry is UNAVAILABLE, not zero', () => {
  const sim = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events: [event('s', { tokenCount: 3 }, { source: 'simulated' })] });
  assert.equal(sim.simulated, true);
  const empty = buildTokenTelemetry({ sessions: [], selectedSessionId: '', events: [] });
  assert.equal(empty.field.outputTokens.value, null);
  assert.equal(empty.field.outputTokens.status, 'UNAVAILABLE');
});
