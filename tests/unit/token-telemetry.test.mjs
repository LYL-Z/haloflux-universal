import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTokenTelemetry } from '../../apps/companion/renderer/token-telemetry.mjs';

const sessions = [{ sessionId: 's1' }, { sessionId: 's2' }];
const event = (id, meta, extra = {}) => ({ eventId: id, sessionId: 's1', timestamp: 1, host: 'deepseek-harness', source: 'host-native', confidence: 'confirmed', eventType: 'output.end', metadata: meta, ...extra });

test('F-11/F-12: output tokens require host output.end and report coverage', () => {
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events: [event('a', { tokenCount: 10 }), event('b', { tokenCount: 5, contextUsed: 100, contextLimit: 1000, model: 'm' })] });
  assert.equal(result.field.outputTokens.value, 15);
  assert.equal(result.field.outputTokens.status, 'HOST_REPORTED_COMPLETE');
  assert.equal(result.field.outputTokens.coverage, 1);
  assert.equal(result.field.inputTokens.value, null);
  assert.equal(result.field.cachedTokens.value, null);
  assert.equal(result.field.reasoningTokens.value, null);
  assert.equal(result.field.contextUsed.value, 100);
  assert.equal(result.field.contextLimit.value, 1000);
  assert.equal(result.field.requestId.status, 'UNAVAILABLE');
});

test('F-11: simulated and real samples never mix; invalid counts are rejected', () => {
  const events = [
    event('real', { tokenCount: 10 }),
    event('sim', { tokenCount: 999 }, { source: 'simulated', eventId: 'sim2' }),
    event('bad1', { tokenCount: -1 }, { eventId: 'bad1' }),
    event('bad2', { tokenCount: 1.5 }, { eventId: 'bad2' }),
    event('bad3', { tokenCount: Number.POSITIVE_INFINITY }, { eventId: 'bad3' }),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.outputTokens.value, 10);
  assert.equal(result.hostSamples.length, 1);
  assert.equal(result.simulatedSamples.length, 1);
  assert.equal(result.field.simulatedOutputTokens.value, 999);
  assert.equal(result.field.simulatedOutputTokens.status, 'SIMULATED');
  assert.equal(result.invalidSamples.length, 3);
  assert.equal(result.hostSamples.some((sample) => sample.source === 'simulated'), false);
});

test('F-11: incomplete output.end coverage is PARTIAL_COVERAGE, not a complete total', () => {
  const events = [
    event('with', { tokenCount: 11 }),
    event('without', {}),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.outputTokens.value, 11);
  assert.equal(result.field.outputTokens.status, 'PARTIAL_COVERAGE');
  assert.equal(result.field.outputTokens.coverage, 0.5);
  assert.equal(result.field.outputTokens.complete, false);
});

test('F-11: run.end and heartbeat totals are not summed as output', () => {
  const events = [
    { ...event('h', { tokenCount: 9000 }), eventType: 'session.heartbeat', source: 'derived' },
    { ...event('r', { tokenCount: 40 }), eventType: 'run.end' },
    event('o1', { tokenCount: 10 }),
    event('o2', { tokenCount: 12 }),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.outputTokens.value, 22);
  assert.equal(result.field.outputTokens.value !== 9052, true);
  assert.equal(result.samples.length, 2);
  assert.equal(result.field.contextUsed.status, 'DERIVED_SNAPSHOT');
  assert.equal(result.field.contextUsed.value, 9000);
});

test('F-12: missing session never falls back; empty selection is distinct', () => {
  const missing = buildTokenTelemetry({ sessions, selectedSessionId: 'does-not-exist', events: [event('a', { tokenCount: 10 })] });
  assert.equal(missing.sessionResolution, 'MISSING');
  assert.equal(missing.field.outputTokens.value, null);
  assert.equal(missing.samples.length, 0);
  const empty = buildTokenTelemetry({ sessions, selectedSessionId: '', events: [event('a', { tokenCount: 10 })] });
  assert.equal(empty.sessionResolution, 'EMPTY');
  assert.equal(empty.field.outputTokens.value, null);
  const found = buildTokenTelemetry({ sessions: [{ sessionId: 's1' }], selectedSessionId: 's1', events: [event('a', { tokenCount: 10 })] });
  assert.equal(found.sessionResolution, 'FOUND');
  assert.equal(found.field.outputTokens.value, 10);
});

test('F-12: snapshot follows timestamp order, not array order, and model is latest at cursor', () => {
  const events = [
    event('late', { tokenCount: 3, contextUsed: 300, model: 'm2' }, { timestamp: 300 }),
    event('early', { tokenCount: 2, contextUsed: 100, model: 'm1' }, { timestamp: 100 }),
    event('middle', { tokenCount: 4, contextUsed: 200, model: 'm1' }, { timestamp: 200 }),
  ];
  const at = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events, snapshotTimestamp: 200, snapshotMode: 'replay' });
  assert.equal(at.field.outputTokens.value, 6);
  assert.equal(at.field.contextUsed.value, 200);
  assert.equal(at.field.contextUsed.status, 'HOST_REPORTED_SNAPSHOT');
  assert.equal(at.snapshot.model, 'm1');
  assert.equal(at.snapshot.mode, 'replay');
  assert.equal(at.snapshot.at, 200);
  assert.equal(at.snapshot.eventId, 'middle');
});

test('F-12: same-timestamp events are stable and simulated contexts are not HOST_REPORTED', () => {
  const events = [
    event('b', { tokenCount: 5, contextUsed: 50 }, { timestamp: 100, source: 'simulated' }),
    event('a', { tokenCount: 7, contextUsed: 70 }, { timestamp: 100, source: 'host-native' }),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events, snapshotTimestamp: 100 });
  assert.equal(result.field.contextUsed.status, 'SIMULATED_SNAPSHOT');
  assert.equal(result.invalidSamples.length, 0);
});

test('F-11: no data is UNAVAILABLE, never zero', () => {
  const noSamples = buildTokenTelemetry({ sessions: [{ sessionId: 's1' }], selectedSessionId: 's1', events: [event('a', {})] });
  assert.equal(noSamples.field.outputTokens.value, null);
  assert.equal(noSamples.field.outputTokens.status, 'UNAVAILABLE');
  assert.equal(noSamples.field.inputTokens.value, null);
  const empty = buildTokenTelemetry({ sessions: [], selectedSessionId: '', events: [] });
  assert.equal(empty.available, false);
});
