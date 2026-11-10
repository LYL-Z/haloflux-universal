/**
 * P4.2-C: evidence graph.
 *
 * Ownership edges require sessionId/runId fields. Causal edges require an
 * explicit parentSpanId that matches an observed spanId. No timestamp proximity
 * is ever promoted to causality.
 */
export function buildEvidenceGraph({ sessions = [], events = [], selectedSessionId = '', maxEvents = 40 } = {}) {
  const all = Array.isArray(events) ? events : [];
  const selected = sessions.find((session) => session.sessionId === selectedSessionId) || sessions[0] || null;
  const sessionId = selected?.sessionId || selectedSessionId || '';
  const scoped = all.filter((event) => !sessionId || event.sessionId === sessionId);
  const runs = new Map();
  for (const event of scoped) {
    const runId = event.metadata?.runId || event.runId || '';
    if (!runId) continue;
    const row = runs.get(runId) || { runId, count: 0, first: event.timestamp, last: event.timestamp, sources: new Set() };
    row.count += 1;
    row.first = Math.min(row.first, event.timestamp);
    row.last = Math.max(row.last, event.timestamp);
    row.sources.add(event.source || 'unknown');
    runs.set(runId, row);
  }
  const spanIds = new Set(scoped.map((event) => event.spanId).filter(Boolean));
  const sampled = scoped.slice(-Math.max(1, maxEvents));
  const nodes = [];
  const edges = [];
  const addNode = (id, kind, label, meta = {}) => {
    nodes.push({ id, kind, label, ...meta });
    return id;
  };
  if (sessionId) addNode(`session:${sessionId}`, 'session', sessionId, { eventCount: scoped.length });
  for (const run of runs.values()) {
    addNode(`run:${run.runId}`, 'run', run.runId, { count: run.count, sources: [...run.sources] });
    if (sessionId) edges.push({ from: `session:${sessionId}`, to: `run:${run.runId}`, kind: 'ownership', evidence: 'metadata.runId' });
  }
  for (const event of sampled) {
    const eventId = event.eventId || `event-${event.timestamp}`;
    const nodeId = `event:${eventId}`;
    addNode(nodeId, 'event', event.eventType || 'event', {
      eventId, event, source: event.source || 'unknown', confidence: event.confidence || 'unknown',
      timestamp: event.timestamp, hasParent: Boolean(event.parentSpanId),
    });
    const runId = event.metadata?.runId || event.runId || '';
    if (runId) edges.push({ from: `run:${runId}`, to: nodeId, kind: 'ownership', evidence: 'metadata.runId' });
    if (event.parentSpanId && spanIds.has(event.parentSpanId)) {
      const parent = scoped.find((candidate) => candidate.spanId === event.parentSpanId);
      if (parent) edges.push({ from: `event:${parent.eventId}`, to: nodeId, kind: 'causal', evidence: 'parentSpanId' });
    } else if (event.parentSpanId) {
      edges.push({ from: 'UNKNOWN_PARENT', to: nodeId, kind: 'unknown', evidence: 'parentSpanId not observed' });
    }
  }
  return {
    sessionId, nodes, edges,
    eventCount: scoped.length,
    sampledEvents: sampled.length,
    runCount: runs.size,
    unknownParents: edges.filter((edge) => edge.kind === 'unknown').length,
    unassignedEvents: scoped.filter((event) => !(event.metadata?.runId || event.runId)).length,
    limitation: 'ownership is metadata.runId; causal edges only when parentSpanId matches an observed spanId',
  };
}
