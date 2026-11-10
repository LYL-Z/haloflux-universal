import test from 'node:test';
import assert from 'node:assert/strict';

import { beamKindForEvent, createBeamState, pulseOpacity } from '../../apps/companion/renderer/event-beams.mjs';

const evt = (id, eventType, extra = {}) => ({ eventId: id, eventType, timestamp: 1000, source: 'host-native', confidence: 'confirmed', ...extra });

test('only observed tool/error event types create beams', () => {
  assert.equal(beamKindForEvent(evt('a', 'tool.start')).direction, 'out');
  assert.equal(beamKindForEvent(evt('b', 'tool.end')).direction, 'in');
  assert.equal(beamKindForEvent(evt('c', 'tool.fail')).direction, 'fail');
  assert.equal(beamKindForEvent(evt('d', 'model.request')), null);
  assert.equal(beamKindForEvent(evt('e', 'reasoning')), null);
  assert.equal(beamKindForEvent({ eventType: 'tool.start' }), null); // missing eventId cannot be traced
});

test('beam ingestion is eventId-idempotent and capped', () => {
  const state = createBeamState({ max: 3, minGapMs: 0 });
  const events = [evt('a', 'tool.start'), evt('b', 'tool.end'), evt('a', 'tool.start'), evt('c', 'tool.fail'), evt('d', 'tool.end'), evt('e', 'tool.start')];
  assert.equal(state.ingest(events, 1000), 5);
  assert.equal(state.pulses.length, 3);
  assert.deepEqual(state.pulses.map((p) => p.eventId), ['c', 'd', 'e']);
  assert.equal(state.ingest(events, 2000), 0);
});

test('beam opacity decays and never invents missing event types', () => {
  const state = createBeamState({ minGapMs: 0 });
  state.ingest([evt('a', 'tool.start')], 1000);
  assert.equal(pulseOpacity(state.pulses[0], 1000), 1);
  assert.ok(pulseOpacity(state.pulses[0], 1700) > 0);
  assert.equal(pulseOpacity(state.pulses[0], 3000), 0);
  state.ingest([evt('m', 'model.request'), evt('r', 'reasoning')], 1000);
  assert.equal(state.pulses.length, 1);
});

test('high-frequency events are rate limited, not silently dropped without a cap', () => {
  const state = createBeamState({ max: 10, minGapMs: 50 });
  for (let i = 0; i < 10; i += 1) state.ingest([evt(`e${i}`, 'tool.start')], 1000 + i * 10);
  assert.ok(state.pulses.length <= 2, `rate limited, got ${state.pulses.length}`);
});
