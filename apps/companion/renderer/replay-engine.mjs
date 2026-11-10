/**
 * Deterministic replay reducer (P3.2-A) with a hot path optimized for long
 * histories (F-05):
 *  - events are sorted exactly once at load;
 *  - timestamps are precomputed and frame lookup is binary search;
 *  - session state uses checkpoints (every 128 events), so a frame applies at
 *    most a small delta instead of rescanning the whole prefix;
 *  - time-band density is aggregated into pixel-sized bins once.
 */
const CHECKPOINT_EVERY = 128;
const DENSITY_BINS = 1024;

export function sortEvents(events) {
  return [...(Array.isArray(events) ? events : [])]
    .filter((event) => event && typeof event.eventType === 'string')
    .sort((a, b) => (a.timestamp - b.timestamp) || String(a.eventId).localeCompare(String(b.eventId)));
}

function recentEntry(event) {
  return {
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
  };
}

/** Incrementally apply one event to a replayed session. */
function applyReplayEvent(session, event) {
  if (!session) {
    session = {
      sessionId: event.sessionId || 'replay',
      host: event.host || 'generic',
      hostVersion: event.hostVersion || '',
      state: 'unknown',
      reportedState: 'unknown',
      source: 'unknown',
      confidence: 'unknown',
      connected: true,
      startedAt: event.timestamp,
      lastEventAt: event.timestamp,
      metrics: {},
      recentEvents: [],
    };
  }
  session.state = event.eventType === 'session.end' ? 'done' : event.state || session.state;
  session.reportedState = event.state || session.reportedState;
  session.source = event.source || session.source;
  session.confidence = event.confidence || session.confidence;
  session.lastEventAt = event.timestamp;
  if (event.metadata && typeof event.metadata === 'object') {
    for (const key of ['model', 'toolName', 'step', 'turn', 'tokensPerSecond', 'contextUsed', 'contextLimit']) {
      if (event.metadata[key] !== undefined) session.metrics[key] = event.metadata[key];
    }
  }
  session.recentEvents.push(recentEntry(event));
  if (session.recentEvents.length > 200) session.recentEvents.splice(0, session.recentEvents.length - 200);
  return session;
}

function cloneSession(session) {
  return {
    ...session,
    metrics: { ...(session.metrics || {}) },
    recentEvents: session.recentEvents.map((entry) => ({ ...entry })),
  };
}

/** Build the session view visible at a given frame index (compat API). */
export function sessionAt(events, index, fallback = {}, { sorted = false } = {}) {
  const list = sorted ? events : sortEvents(events);
  if (list.length === 0) return null;
  const cursor = Math.max(0, Math.min(list.length - 1, Math.floor(index)));
  let session = null;
  for (let i = 0; i <= cursor; i += 1) session = applyReplayEvent(session, list[i]);
  if (!session) return null;
  return {
    ...session,
    sessionId: session.sessionId || fallback.sessionId || 'replay',
    host: session.host || fallback.host || 'generic',
    hostVersion: session.hostVersion || fallback.hostVersion || '',
    state: session.state || fallback.state || 'unknown',
    metrics: { ...(fallback.metrics || {}), ...session.metrics },
  };
}

/** Precompute everything the 200 ms replay loop needs. */
export function prepareReplay(events, { checkpointEvery = CHECKPOINT_EVERY, bins = DENSITY_BINS } = {}) {
  const list = sortEvents(events);
  const timestamps = new Float64Array(list.length);
  for (let i = 0; i < list.length; i += 1) timestamps[i] = list[i].timestamp;
  const durationMs = list.length > 1 ? Math.max(0, timestamps[list.length - 1] - timestamps[0]) : 0;
  const density = new Uint32Array(Math.max(1, bins));
  if (list.length > 0) {
    const start = timestamps[0];
    const span = Math.max(1, durationMs);
    for (const event of list) {
      const bin = Math.min(bins - 1, Math.max(0, Math.floor(((event.timestamp - start) / span) * (bins - 1))));
      density[bin] += 1;
    }
  }
  const checkpoints = [];
  const toolCounts = new Uint32Array(list.length || 1);
  const errorCounts = new Uint32Array(list.length || 1);
  let session = null;
  let toolCount = 0;
  let errorCount = 0;
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i];
    if (typeof event.eventType === 'string' && event.eventType.startsWith('tool.')) toolCount += 1;
    if (typeof event.eventType === 'string' && /error|fail/i.test(event.eventType)) errorCount += 1;
    toolCounts[i] = toolCount;
    errorCounts[i] = errorCount;
    session = applyReplayEvent(session, event);
    if (i % checkpointEvery === 0) checkpoints.push({ index: i, session: cloneSession(session) });
  }
  function indexAt(elapsedMs, speed = 1) {
    if (!list.length) return 0;
    const target = timestamps[0] + Math.max(0, elapsedMs) * Math.max(0.1, Number(speed) || 1);
    let lo = 0;
    let hi = timestamps.length - 1;
    let answer = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timestamps[mid] <= target) { answer = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return answer;
  }
  function sessionAtIndex(index, fallback = {}) {
    if (!list.length) return null;
    const cursor = Math.max(0, Math.min(list.length - 1, Math.floor(index)));
    let checkpoint = checkpoints[0];
    for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
      if (checkpoints[i].index <= cursor) { checkpoint = checkpoints[i]; break; }
    }
    const base = checkpoint ? cloneSession(checkpoint.session) : null;
    let sessionValue = base;
    const from = checkpoint ? checkpoint.index + 1 : 0;
    for (let i = from; i <= cursor; i += 1) sessionValue = applyReplayEvent(sessionValue, list[i]);
    return {
      ...sessionValue,
      sessionId: sessionValue.sessionId || fallback.sessionId || 'replay',
      metrics: { ...(fallback.metrics || {}), ...sessionValue.metrics },
    };
  }
  return {
    events: list,
    timestamps,
    durationMs,
    density,
    checkpoints,
    indexAt,
    sessionAtIndex,
    eventAt: (index) => list[Math.max(0, Math.min(list.length - 1, Math.floor(index)))] || null,
    toolCountAt: (index) => (list.length ? toolCounts[Math.max(0, Math.min(list.length - 1, Math.floor(index)))] : 0),
    errorCountAt: (index) => (list.length ? errorCounts[Math.max(0, Math.min(list.length - 1, Math.floor(index)))] : 0),
  };
}

/** Index of the last event whose relative timestamp is <= elapsed*speed. */
export function frameIndexAt(events, elapsedMs, speed = 1) {
  const list = sortEvents(events);
  if (list.length === 0) return 0;
  const base = list[0].timestamp;
  const target = base + Math.max(0, elapsedMs) * Math.max(0.1, Number(speed) || 1);
  let lo = 0;
  let hi = list.length - 1;
  let answer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timestamp <= target) { answer = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return answer;
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
