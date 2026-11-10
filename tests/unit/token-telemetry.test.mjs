import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTokenTelemetry } from '../../apps/companion/renderer/token-telemetry.mjs';

const sessions = [{ sessionId: 's1' }, { sessionId: 's2' }];
const event = (id, meta, extra = {}) => ({ eventId: id, sessionId: 's1', timestamp: 1, host: 'deepseek-harness', source: 'host-native', confidence: 'confirmed', eventType: 'output.end', metadata: meta, ...extra });

test('F-13: host/derived/simulated coverage is separate and cannot complete the real total', () => {
  const events = [
    event('h', { tokenCount: 10 }),
    event('s', { tokenCount: 999 }, { eventId: 's', source: 'simulated' }),
    event('d', { tokenCount: 50 }, { eventId: 'd', source: 'derived' }),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.outputTokens.value, 10);
  assert.equal(result.field.outputTokens.coverage, 1);
  assert.equal(result.field.outputTokens.status, 'HOST_REPORTED_COMPLETE');
  assert.equal(result.field.outputTokens.complete, true);
  assert.equal(result.field.simulatedOutputTokens.value, 999);
  assert.equal(result.field.simulatedOutputTokens.coverage, 1);
  assert.equal(result.field.derivedOutputTokens.value, 50);
  assert.equal(result.field.derivedOutputTokens.coverage, 1);
  assert.equal(result.field.outputTokens.value, 10, 'simulated/derived never enter real total');
});

test('F-13: host partial coverage is PARTIAL_COVERAGE and complete=false', () => {
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events: [event('a', { tokenCount: 11 }), event('b', {})] });
  assert.equal(result.field.outputTokens.value, 11);
  assert.equal(result.field.outputTokens.status, 'PARTIAL_COVERAGE');
  assert.equal(result.field.outputTokens.coverage, 0.5);
  assert.equal(result.field.outputTokens.complete, false);
});

test('F-13: contextUsed=0 is valid and does not borrow heartbeat provenance', () => {
  const events = [
    event('zero', { contextUsed: 0, contextLimit: 1000 }),
    { ...event('hb', { tokenCount: 5000 }), eventType: 'session.heartbeat', source: 'derived' },
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.contextUsed.value, 0);
  assert.equal(result.field.contextUsed.status, 'HOST_REPORTED_SNAPSHOT');
  assert.equal(result.field.contextUsed.eventId, 'zero');
  assert.equal(result.field.contextUsed.source, 'host-native');
});

test('F-13: simulated contextLimit is SIMULATED_SNAPSHOT, not HOST_REPORTED', () => {
  const result = buildTokenTelemetry({
    sessions,
    selectedSessionId: 's1',
    events: [event('sim', { contextUsed: 100, contextLimit: 5000 }, { source: 'simulated' })],
  });
  assert.equal(result.field.contextUsed.value, 100);
  assert.equal(result.field.contextUsed.status, 'SIMULATED_SNAPSHOT');
  assert.equal(result.field.contextLimit.value, 5000);
  assert.equal(result.field.contextLimit.status, 'SIMULATED_SNAPSHOT');
});

test('F-14: same timestamp replay step uses visible event IDs, not timestamp equality', () => {
  const events = [
    event('first', { tokenCount: 10, contextUsed: 100 }, { timestamp: 100 }),
    event('second', { tokenCount: 999, contextUsed: 999 }, { timestamp: 100 }),
  ];
  const firstStep = buildTokenTelemetry({
    sessions, selectedSessionId: 's1', events,
    snapshotTimestamp: 100, snapshotMode: 'replay',
    visibleEventIds: new Set(['first']),
  });
  assert.equal(firstStep.field.outputTokens.value, 10);
  assert.equal(firstStep.field.contextUsed.value, 100);
  assert.equal(firstStep.snapshot.visibleCount, 1);
  const secondStep = buildTokenTelemetry({
    sessions, selectedSessionId: 's1', events,
    snapshotTimestamp: 100, snapshotMode: 'replay',
    visibleEventIds: new Set(['first', 'second']),
  });
  assert.equal(secondStep.field.outputTokens.value, 1009);
  assert.equal(secondStep.field.contextUsed.value, 999);
  assert.equal(secondStep.snapshot.visibleCount, 2);
});

test('F-11/F-12: invalid values, run/heartbeat totals and missing sessions stay safe', () => {
  const events = [
    event('bad1', { tokenCount: -1 }, { eventId: 'bad1' }),
    event('bad2', { tokenCount: 1.5 }, { eventId: 'bad2' }),
    { ...event('r', { tokenCount: 40 }), eventType: 'run.end' },
    { ...event('h', { tokenCount: 9000 }), eventType: 'session.heartbeat', source: 'derived' },
    event('o', { tokenCount: 10 }),
  ];
  const result = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events });
  assert.equal(result.field.outputTokens.value, 10);
  assert.equal(result.invalidSamples.length, 2);
  assert.equal(result.field.contextUsed.status, 'DERIVED_SNAPSHOT');
  const missing = buildTokenTelemetry({ sessions, selectedSessionId: 'nope', events });
  assert.equal(missing.sessionResolution, 'MISSING');
  assert.equal(missing.field.outputTokens.value, null);
  const empty = buildTokenTelemetry({ sessions, selectedSessionId: '', events });
  assert.equal(empty.sessionResolution, 'EMPTY');
  assert.equal(empty.field.outputTokens.value, null);
});

test('F-12: timestamp snapshot and model switch use latest readable snapshot', () => {
  const events = [
    event('late', { tokenCount: 3, contextUsed: 300, model: 'm2' }, { timestamp: 300 }),
    event('early', { tokenCount: 2, contextUsed: 100, model: 'm1' }, { timestamp: 100 }),
    event('middle', { tokenCount: 4, contextUsed: 200, model: 'm1' }, { timestamp: 200 }),
  ];
  const at = buildTokenTelemetry({ sessions, selectedSessionId: 's1', events, snapshotTimestamp: 200, snapshotMode: 'replay' });
  assert.equal(at.field.outputTokens.value, 6);
  assert.equal(at.field.contextUsed.value, 200);
  assert.equal(at.snapshot.model, 'm1');
  assert.equal(at.snapshot.mode, 'replay');
  assert.equal(at.snapshot.eventId, 'middle');
});
