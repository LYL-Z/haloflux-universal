/**
 * Deterministic replay reducer (P3.2-A).
 *
 * The UI never re-runs a model or a tool: it replays the stored, validated
 * event stream at a chosen speed. Frames are pure data derived from timestamps;
 * therefore the same history always yields the same frame index.
 */

export function sortEvents(events) {
  return [...(Array.isArray(events) ? events : [])]
    .filter((event) => event && typeof event.eventType === 'string')
    .sort((a, b) => (a.timestamp - b.timestamp) || String(a.eventId).localeCompare(String(b.eventId)));
}

/** Build the session view visible at a given frame index. */
export function sessionAt(events, index, fallback = {}) {
  const list = sortEvents(events);
  if (list.length === 0) return null;
  const cursor = Math.max(0, Math.min(list.length - 1, Math.floor(index)));
  const visible = list.slice(0, cursor + 1);
  const last = visible[visible.length - 1];
  const first = visible[0];
  const metrics = { ...(fallback.metrics || {}) };
  for (const event of visible) {
    if (event.metadata && typeof event.metadata === 'object') {
      for (const key of ['model', 'toolName', 'step', 'turn', 'tokensPerSecond', 'contextUsed', 'contextLimit']) {
        if (event.metadata[key] !== undefined) metrics[key] = event.metadata[key];
      }
    }
  }
  return {
    sessionId: last.sessionId || fallback.sessionId || 'replay',
    host: last.host || fallback.host || 'generic',
    hostVersion: last.hostVersion || fallback.hostVersion || '',
    state: last.eventType === 'session.end' ? 'done' : last.state || fallback.state || 'unknown',
    reportedState: last.state || fallback.reportedState || 'unknown',
    source: last.source || 'unknown',
    confidence: last.confidence || 'unknown',
    connected: true,
    startedAt: first.timestamp,
    lastEventAt: last.timestamp,
    metrics,
    recentEvents: visible.slice(-200).map((event) => ({
      eventType: event.eventType,
      timestamp: event.timestamp,
      source: event.source,
      confidence: event.confidence,
      ...(event.metadata?.toolName ? { toolName: event.metadata.toolName } : {}),
      ...(event.metadata?.toolCallId ? { toolCallId: event.metadata.toolCallId } : {}),
      ...(event.metadata?.runId ? { runId: event.metadata.runId } : {}),
      ...(event.metadata?.durationMs !== undefined ? { durationMs: event.metadata.durationMs } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.spanId ? { spanId: event.spanId } : {}),
    })),
  };
}

/** Index of the last event whose relative timestamp is <= elapsed*speed. */
export function frameIndexAt(events, elapsedMs, speed = 1) {
  const list = sortEvents(events);
  if (list.length === 0) return 0;
  const base = list[0].timestamp;
  const target = base + Math.max(0, elapsedMs) * Math.max(0.1, Number(speed) || 1);
  let index = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].timestamp <= target) index = i;
    else break;
  }
  return index;
}

export function replayDurationMs(events) {
  const list = sortEvents(events);
  if (list.length < 2) return 0;
  return Math.max(0, list[list.length - 1].timestamp - list[0].timestamp);
}

/** One deterministic "step" from an index. */
export function stepIndex(events, index, delta = 1) {
  const list = sortEvents(events);
  return Math.max(0, Math.min(list.length - 1, Math.floor(index) + Math.floor(delta)));
}
