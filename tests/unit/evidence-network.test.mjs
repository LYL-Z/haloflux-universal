import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEvidenceGraph } from '../../apps/companion/renderer/evidence-network.mjs';

const events = [
  { eventId: 'e1', sessionId: 's1', timestamp: 1, eventType: 'tool.start', spanId: 'span-a', metadata: { runId: 'r1' } },
  { eventId: 'e2', sessionId: 's1', timestamp: 2, eventType: 'tool.end', parentSpanId: 'span-a', metadata: { runId: 'r1' } },
  { eventId: 'e3', sessionId: 's1', timestamp: 3, eventType: 'output.end', parentSpanId: 'missing', metadata: { runId: 'r2' } },
  { eventId: 'e4', sessionId: 's1', timestamp: 4, eventType: 'session.heartbeat', metadata: {} },
];

test('evidence graph aggregates runs and samples events', () => {
  const graph = buildEvidenceGraph({ sessions: [{ sessionId: 's1' }], events, selectedSessionId: 's1', maxEvents: 2 });
  assert.equal(graph.runCount, 2);
  assert.equal(graph.eventCount, 4);
  assert.equal(graph.sampledEvents, 2);
  assert.ok(graph.nodes.some((node) => node.kind === 'session'));
  assert.ok(graph.nodes.some((node) => node.kind === 'run' && node.label === 'r1'));
});

test('ownership and causal edges are distinct and no timestamp inference exists', () => {
  const graph = buildEvidenceGraph({ sessions: [{ sessionId: 's1' }], events, selectedSessionId: 's1', maxEvents: 10 });
  const ownership = graph.edges.filter((edge) => edge.kind === 'ownership');
  const causal = graph.edges.filter((edge) => edge.kind === 'causal');
  assert.ok(ownership.find((edge) => edge.from.startsWith('run:') && edge.to === 'event:e1'));
  assert.deepEqual(causal, [{ from: 'event:e1', to: 'event:e2', kind: 'causal', evidence: 'parentSpanId' }]);
  const unknown = graph.edges.filter((edge) => edge.kind === 'unknown');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].from, 'UNKNOWN_PARENT');
});

test('missing runs and empty sessions degrade to UNKNOWN, not fabricated nodes', () => {
  const graph = buildEvidenceGraph({ sessions: [], events: [], selectedSessionId: '' });
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
  const noRun = buildEvidenceGraph({ sessions: [{ sessionId: 's1' }], events: [{ eventId: 'x', sessionId: 's1', timestamp: 1, eventType: 'output.end' }], selectedSessionId: 's1' });
  assert.equal(noRun.runCount, 0);
  assert.equal(noRun.unassignedEvents, 1);
});
