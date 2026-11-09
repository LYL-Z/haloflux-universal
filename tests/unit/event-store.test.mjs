import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createEvent } from '../../packages/event-schema/dist/index.js';
import { EventStore, eventStorePath } from '../../packages/event-store/src/index.mjs';

function evt(overrides = {}) {
  return createEvent({
    host: 'deepseek-harness',
    sessionId: 'session-store-1',
    eventType: 'tool.start',
    source: 'host-native',
    confidence: 'confirmed',
    timestamp: 1000,
    metadata: { toolName: 'Bash', toolCallId: 'call-1', runId: 'run-1' },
    ...overrides,
  });
}

test('event store persists across reopen and deduplicates eventId', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-store-'));
  const file = eventStorePath(home);
  const a = evt({ eventId: 'evt-store-0001' });
  const b = evt({ eventId: 'evt-store-0002', timestamp: 2000, eventType: 'tool.end', metadata: { toolName: 'Bash', toolCallId: 'call-1', runId: 'run-1' } });
  let store = new EventStore({ home });
  assert.equal(store.append(a).inserted, true);
  assert.equal(store.append(a).inserted, false);
  assert.deepEqual(store.appendMany([a, b]), { inserted: 1, duplicates: 1, total: 2 });
  assert.equal(store.stats().events, 2);
  store.close();

  store = new EventStore({ home });
  assert.equal(store.stats().events, 2, 'events survive close/reopen');
  const q = store.query({ sessionId: 'session-store-1', runId: 'run-1' });
  assert.equal(q.total, 2);
  assert.equal(q.events[0].eventId, 'evt-store-0001');
  assert.equal(q.events[0].source, 'host-native');
  assert.equal(q.events[0].confidence, 'confirmed');
  assert.equal(q.events[0].metadata.runId, 'run-1');
  assert.equal(store.integrityCheck(), 'ok');
  assert.ok(store.stats().sizeBytes > 0);
  store.close();
  rmSync(home, { recursive: true, force: true });
  assert.equal(file.endsWith('haloflux-events.sqlite'), true);
});

test('event store supports time windows, deletion and retention pruning', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-store-'));
  const store = new EventStore({ home });
  store.appendMany([
    evt({ eventId: 'evt-time-0001', timestamp: 1000 }),
    evt({ eventId: 'evt-time-0002', timestamp: 5000 }),
    evt({ eventId: 'evt-time-0003', timestamp: 9000 }),
  ]);
  const window = store.query({ from: 2000, to: 8000 });
  assert.deepEqual(window.events.map((e) => e.eventId), ['evt-time-0002']);
  assert.equal(store.pruneBefore(4000).deleted, 1);
  assert.equal(store.stats().events, 2);
  assert.equal(store.deleteSession('session-store-1').deleted, 2);
  assert.equal(store.stats().events, 0);
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test('event store survives a second concurrent writer and an unclean reopen', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-store-'));
  const first = new EventStore({ home });
  const second = new EventStore({ home });
  assert.equal(first.append(evt({ eventId: 'evt-concurrent-01', timestamp: 1000 })).inserted, true);
  assert.equal(second.append(evt({ eventId: 'evt-concurrent-02', timestamp: 2000 })).inserted, true);
  assert.equal(second.stats().events, 2);
  // Simulate leaving the first connection open (crash): a new reader still sees
  // the committed rows through WAL.
  const reader = new EventStore({ home, readonly: true });
  assert.equal(reader.query({ limit: 10 }).total, 2);
  reader.close();
  second.close();
  first.close();
  const reopened = new EventStore({ home });
  assert.equal(reopened.query({ limit: 10 }).total, 2);
  assert.equal(reopened.integrityCheck(), 'ok');
  reopened.close();
  rmSync(home, { recursive: true, force: true });
});

test('event store refuses events that fail the privacy schema', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-store-'));
  const store = new EventStore({ home });
  assert.throws(() => store.append({ schemaVersion: 1, eventId: 'bad', metadata: { prompt: 'secret' } }), /refusing invalid event/);
  store.close();
  rmSync(home, { recursive: true, force: true });
});
