import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTimeArc, angleForTimestamp, timestampForRatio, eventIndexAtTimestamp } from '../../apps/companion/renderer/time-arc.mjs';

const events = [
  { eventId: 'b', timestamp: 200, source: 'host-native', eventType: 'tool.start' },
  { eventId: 'a', timestamp: 100, source: 'derived', eventType: 'tool.end' },
  { eventId: 'c', timestamp: 300, source: 'simulated', eventType: 'output.end' },
];

test('time arc keeps real timestamps and stable sort, never causal order', () => {
  const arc = buildTimeArc(events);
  assert.deepEqual(arc.list.map((e) => e.eventId), ['a', 'b', 'c']);
  assert.equal(arc.start, 100);
  assert.equal(arc.end, 300);
  assert.equal(arc.visible, 3);
  assert.equal(arc.counts.reduce((a, b) => a + b, 0), 3);
});

test('time arc bins are deterministic and source-labeled', () => {
  const a = buildTimeArc(events, { bins: 8 });
  const b = buildTimeArc(events, { bins: 8 });
  assert.deepEqual([...a.counts], [...b.counts]);
  assert.equal(a.host.reduce((x, y) => x + y, 0), 1);
  assert.equal(a.derived.reduce((x, y) => x + y, 0), 1);
  assert.equal(a.simulated.reduce((x, y) => x + y, 0), 1);
});

test('time arc window, missing timestamps, empty history and click mapping', () => {
  const arc = buildTimeArc([...events, { eventId: 'no-ts', eventType: 'unknown' }], { from: 100, to: 300 });
  assert.equal(arc.visible, 3);
  assert.equal(arc.missingTimestamp, 1);
  assert.equal(angleForTimestamp(100, arc), 0);
  assert.equal(angleForTimestamp(300, arc), Math.PI * 2);
  assert.equal(timestampForRatio(0.5, arc), 200);
  assert.equal(eventIndexAtTimestamp(arc, 205), 1);
  assert.equal(eventIndexAtTimestamp(arc, 299), 2);
  assert.equal(eventIndexAtTimestamp(buildTimeArc([]), 1), -1);
  assert.equal(buildTimeArc([]).visible, 0);
});
