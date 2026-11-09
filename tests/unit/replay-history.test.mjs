import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReplayAt, collectReplayPages } from '../../apps/companion/renderer/replay-history.mjs';

test('at parameter distinguishes absent, zero, valid and invalid', () => {
  assert.deepEqual(parseReplayAt(null), { present: false, valid: false, value: null });
  assert.deepEqual(parseReplayAt('0'), { present: true, valid: true, value: 0 });
  assert.deepEqual(parseReplayAt('42'), { present: true, valid: true, value: 42 });
  assert.equal(parseReplayAt('').valid, false);
  assert.equal(parseReplayAt('-1').valid, false);
  assert.equal(parseReplayAt('1.5').valid, false);
  assert.equal(parseReplayAt('abc').valid, false);
});

function makeEvents(count, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `evt-${i}`, timestamp: start + i, sessionId: 's', eventType: 'tool.start', source: 'host-native', confidence: 'confirmed', metadata: {},
  }));
}

test('collectReplayPages loads all pages with a stable snapshot and no duplicates', async () => {
  const all = makeEvents(2500);
  const calls = [];
  const result = await collectReplayPages({
    pageSize: 1000,
    maxEvents: 20000,
    snapshotTo: 999999,
    fetchPage: async ({ offset, limit, to }) => {
      calls.push({ offset, limit, to });
      return { events: all.slice(offset, offset + limit), total: all.length };
    },
  });
  assert.equal(result.total, 2500);
  assert.equal(result.loaded, 2500);
  assert.equal(result.partial, false);
  assert.equal(result.pages, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.to === 999999));
  assert.equal(result.events[0].eventId, 'evt-0');
  assert.equal(result.events.at(-1).eventId, 'evt-2499');
  assert.equal(new Set(result.events.map((e) => e.eventId)).size, 2500);
});

test('collectReplayPages stops at the cap and marks PARTIAL', async () => {
  const all = makeEvents(5000);
  const result = await collectReplayPages({
    pageSize: 1000,
    maxEvents: 2000,
    fetchPage: async ({ offset, limit }) => ({ events: all.slice(offset, offset + limit), total: all.length }),
  });
  assert.equal(result.loaded, 2000);
  assert.equal(result.total, 5000);
  assert.equal(result.partial, true);
  assert.equal(result.pages, 2);
});

test('collectReplayPages does not request pages beyond a writer snapshot', async () => {
  const before = makeEvents(1200);
  let appended = false;
  const result = await collectReplayPages({
    pageSize: 1000,
    snapshotTo: 1234,
    fetchPage: async ({ offset, limit, to }) => {
      assert.equal(to, 1234);
      if (offset === 1000) appended = true;
      return { events: before.slice(offset, offset + limit), total: before.length };
    },
  });
  assert.equal(result.loaded, 1200);
  assert.equal(result.total, 1200);
  assert.equal(appended, true);
  assert.equal(result.partial, false);
});
