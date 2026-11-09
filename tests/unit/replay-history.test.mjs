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

function fakeServer(all, { snapshotTotal = all.length, pageSize = 1000 } = {}) {
  return async ({ afterSeq, limit }) => {
    const offset = Number(afterSeq) || 0;
    const events = all.slice(offset, offset + Math.min(limit, pageSize));
    const next = offset + events.length;
    return {
      events,
      total: snapshotTotal,
      snapshotSeq: all.length,
      nextCursor: events.length ? next : null,
    };
  };
}

test('collectReplayPages loads all pages with a stable ingestion cursor and no duplicates', async () => {
  const all = makeEvents(2500);
  const calls = [];
  const result = await collectReplayPages({
    pageSize: 1000,
    maxEvents: 20000,
    fetchPage: async (args) => { calls.push(args); return fakeServer(all)(args); },
  });
  assert.equal(result.total, 2500);
  assert.equal(result.loaded, 2500);
  assert.equal(result.partial, false);
  assert.equal(result.pages, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].afterSeq, 0);
  assert.equal(calls[1].afterSeq, 1000);
  assert.equal(calls[2].afterSeq, 2000);
  assert.equal(result.events[0].eventId, 'evt-0');
  assert.equal(result.events.at(-1).eventId, 'evt-2499');
  assert.equal(new Set(result.events.map((e) => e.eventId)).size, 2500);
});

test('collectReplayPages stops at the cap and marks PARTIAL', async () => {
  const all = makeEvents(5000);
  const result = await collectReplayPages({
    pageSize: 1000,
    maxEvents: 2000,
    fetchPage: fakeServer(all),
  });
  assert.equal(result.loaded, 2000);
  assert.equal(result.total, 5000);
  assert.equal(result.partial, true);
  assert.equal(result.pages, 2);
});

test('a late event with an older timestamp cannot enter an existing snapshot', async () => {
  const original = makeEvents(1200);
  // The server snapshot only exposes the first 1200 rows. A late row with
  // timestamp 1 would be ignored by the ingestion cursor, not by timestamp.
  const withLate = [...original, { ...makeEvents(1, 1)[0], eventId: 'evt-late', timestamp: 1 }];
  const result = await collectReplayPages({ pageSize: 1000, fetchPage: fakeServer(original) });
  assert.equal(result.loaded, 1200);
  assert.equal(result.events.some((e) => e.eventId === 'evt-late'), false);
  assert.equal(withLate.length, 1201);
});

test('deletion/retention during paging produces PARTIAL instead of silent completeness', async () => {
  const all = makeEvents(1500);
  let first = true;
  const result = await collectReplayPages({
    pageSize: 1000,
    fetchPage: async (args) => {
      if (first) {
        first = false;
        return { events: all.slice(0, 1000), total: 1500, snapshotSeq: 1500, nextCursor: 1000 };
      }
      // Retention deletes the remaining 500 rows after page 1.
      return { events: [], total: 1500, snapshotSeq: 1500, nextCursor: null };
    },
  });
  assert.equal(result.loaded, 1000);
  assert.equal(result.total, 1500);
  assert.equal(result.partial, true);
});
