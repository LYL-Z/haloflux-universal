import test from 'node:test';
import assert from 'node:assert/strict';

import { sortEvents, sessionAt, frameIndexAt, replayDurationMs, stepIndex } from '../../apps/companion/renderer/replay-engine.mjs';

const events = [
  { eventId: 'e1', timestamp: 1000, sessionId: 's1', host: 'deepseek-harness', eventType: 'session.start', state: 'connected', source: 'host-native', confidence: 'confirmed' },
  { eventId: 'e2', timestamp: 2000, sessionId: 's1', host: 'deepseek-harness', eventType: 'tool.start', state: 'tool', source: 'host-native', confidence: 'confirmed', metadata: { toolName: 'Bash', toolCallId: 'c1', runId: 'r1' } },
  { eventId: 'e3', timestamp: 2600, sessionId: 's1', host: 'deepseek-harness', eventType: 'tool.end', state: 'output', source: 'host-native', confidence: 'confirmed', metadata: { toolName: 'Bash', toolCallId: 'c1', durationMs: 600 } },
  { eventId: 'e4', timestamp: 3000, sessionId: 's1', host: 'deepseek-harness', eventType: 'session.end', state: 'done', source: 'derived', confidence: 'inferred' },
];

test('replay frames are deterministic and preserve event provenance', () => {
  const sorted = sortEvents([...events].reverse());
  assert.deepEqual(sorted.map((event) => event.eventId), ['e1', 'e2', 'e3', 'e4']);
  assert.equal(frameIndexAt(events, 0), 0);
  assert.equal(frameIndexAt(events, 700), 0);
  assert.equal(frameIndexAt(events, 1100), 1);
  assert.equal(frameIndexAt(events, 1700), 2);
  assert.equal(frameIndexAt(events, 2100), 3);
  assert.equal(stepIndex(events, 1, 1), 2);
  assert.equal(stepIndex(events, 0, -1), 0);
  assert.equal(replayDurationMs(events), 2000);
});

test('sessionAt only shows events up to the frame and keeps per-event source', () => {
  const mid = sessionAt(events, 1);
  assert.equal(mid.recentEvents.length, 2);
  assert.equal(mid.state, 'tool');
  assert.equal(mid.recentEvents[1].source, 'host-native');
  assert.equal(mid.recentEvents[1].toolCallId, 'c1');
  const end = sessionAt(events, 3);
  assert.equal(end.recentEvents.length, 4);
  assert.equal(end.recentEvents[3].source, 'derived');
  assert.equal(end.state, 'done');
});
