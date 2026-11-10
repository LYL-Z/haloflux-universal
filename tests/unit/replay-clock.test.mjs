import test from 'node:test';
import assert from 'node:assert/strict';

import { replayNow, replayWindow } from '../../apps/companion/renderer/replay-clock.mjs';
import { eventRate } from '../../packages/analytics/src/index.mjs';

const day = 86_400_000;
const historical = Date.now() - day;

test('F-10 replay uses the event timestamp at the cursor, not today', () => {
  const replay = {
    index: 2,
    events: [
      { eventId: 'a', timestamp: historical, eventType: 'tool.start' },
      { eventId: 'b', timestamp: historical + 1000, eventType: 'tool.end' },
      { eventId: 'c', timestamp: historical + 2000, eventType: 'error' },
    ],
  };
  assert.equal(replayNow({ replay, liveNow: Date.now() }), historical + 2000);
  const window = replayWindow({ replay, liveNow: Date.now(), windowMs: 120_000 });
  assert.equal(window.now, historical + 2000);
  assert.equal(window.from, historical + 2000 - 120_000);
});

test('F-10 pause/step/seek keep the virtual clock on the visible event', () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ eventId: `e${i}`, timestamp: historical + i * 10 }));
  for (const index of [0, 1, 4]) {
    assert.equal(replayNow({ replay: { index, events } }), historical + index * 10);
  }
  assert.equal(replayNow({ replay: { index: 0, events } }), historical); // at=0
  assert.equal(replayNow({ replay: { index: 4, events } }), historical + 40); // seek to end
});

test('F-10 LIVE still uses the wall clock and empty replay falls back safely', () => {
  const now = Date.now();
  assert.equal(replayNow({ replay: null, liveNow: now }), now);
  assert.equal(replayNow({ replay: { index: 0, events: [] }, liveNow: now }), now);
  assert.equal(replayNow({ replay: { index: 99, events: [{ timestamp: historical }] }, liveNow: now }), historical);
});

test('F-10 a yesterday execution still produces a non-empty 120s window when replayed today', () => {
  const events = [
    { eventType: 'tool.start', timestamp: historical, toolName: 'Bash', source: 'simulated' },
    { eventType: 'tool.end', timestamp: historical + 1000, toolName: 'Bash', source: 'simulated' },
    { eventType: 'error', timestamp: historical + 2000, source: 'simulated' },
  ];
  const replay = { index: 2, events };
  const nowToday = Date.now();
  const wall = eventRate(events, { now: nowToday, windowMs: 120_000, buckets: 12 });
  const virtual = eventRate(events, { now: replayNow({ replay, liveNow: nowToday }), windowMs: 120_000, buckets: 12 });
  assert.equal(wall.count, 0, 'wall-clock replay must be the historical bug');
  assert.equal(virtual.count, 3, 'virtual clock must show the observed historical events');
});
