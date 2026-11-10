/**
 * P4.3-R2 token telemetry.
 *
 * Truth rules:
 *  - only output.end carries per-message output tokens;
 *  - run.end turn totals and heartbeat context snapshots are never added to
 *    output tokens;
 *  - host-native/derived/simulated/unknown groups have separate totals and
 *    separate coverage; simulated data never enters the real total;
 *  - coverage is source-specific; incomplete coverage is not complete;
 *  - a missing/unknown session never falls back to another session;
 *  - REPLAY visibility is by explicit visible event IDs when supplied, so two
 *    same-timestamp events cannot leak the second into the first step.
 */
const UNAVAILABLE = 'UNAVAILABLE';
const SOURCE_KEYS = ['host-native', 'derived', 'simulated', 'unknown'];

function validTokenValue(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
}

function sourceKey(source) {
  return SOURCE_KEYS.includes(source) ? source : 'unknown';
}

function snapshotStatus(source, confidence) {
  if (source === 'simulated') return 'SIMULATED_SNAPSHOT';
  if (source === 'derived') return 'DERIVED_SNAPSHOT';
  if (source === 'unknown' || !source) return 'UNKNOWN_SNAPSHOT';
  return confidence === 'confirmed' || confidence === 'inferred' ? 'HOST_REPORTED_SNAPSHOT' : 'HOST_REPORTED_SNAPSHOT';
}

export function buildTokenTelemetry({
  events = [], sessions = [], selectedSessionId = '',
  snapshotTimestamp = null, snapshotMode = 'current', visibleEventIds = null,
} = {}) {
  let session = null;
  let sessionResolution = 'EMPTY';
  if (selectedSessionId !== undefined && selectedSessionId !== null && selectedSessionId !== '') {
    session = sessions.find((row) => row.sessionId === selectedSessionId) || null;
    sessionResolution = session ? 'FOUND' : 'MISSING';
  }
  const sessionId = session?.sessionId || '';
  const scoped = sessionResolution === 'FOUND'
    ? (Array.isArray(events) ? events : []).filter((event) => event.sessionId === sessionId)
    : [];
  const ordered = scoped.slice().sort((a, b) =>
    (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0)
    || String(a.eventId || '').localeCompare(String(b.eventId || '')));
  const at = snapshotTimestamp === null || snapshotTimestamp === undefined
    ? (ordered.length ? Number(ordered[ordered.length - 1].timestamp) : 0)
    : Number(snapshotTimestamp);
  const idSet = visibleEventIds instanceof Set ? visibleEventIds : null;
  const visible = ordered.filter((event) => idSet
    ? idSet.has(event.eventId)
    : Number.isFinite(event.timestamp) && event.timestamp <= at);
  const cursorEvent = visible.length ? visible[visible.length - 1] : null;

  const seen = new Set();
  const samples = [];
  const invalidSamples = [];
  const stats = Object.fromEntries(SOURCE_KEYS.map((key) => [key, {
    outputEnd: 0, withToken: 0, sum: 0, coverage: 0,
  }]));
  let heartbeatContext = null;
  let latestContext = null;
  let latestContextLimit = null;
  let latestModel = '';
  let latestModelEventId = '';
  let latestContextEventId = '';
  let latestContextSource = 'unknown';
  let latestContextConfidence = 'unknown';
  let latestContextLimitEventId = '';
  let latestContextLimitSource = 'unknown';
  let latestContextLimitConfidence = 'unknown';
  let simulatedSeen = false;

  for (const event of visible) {
    if (!event?.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    if (event.source === 'simulated') simulatedSeen = true;
    if (event.eventType === 'output.end') {
      const group = sourceKey(event.source || 'unknown');
      stats[group].outputEnd += 1;
      if (meta.tokenCount !== undefined && meta.tokenCount !== null) {
        if (validTokenValue(meta.tokenCount)) {
          stats[group].withToken += 1;
          const value = Number(meta.tokenCount);
          stats[group].sum += value;
          samples.push({
            eventId: event.eventId, sessionId: event.sessionId || '',
            runId: event.metadata?.runId || event.runId || '', host: event.host || '',
            model: meta.model || '', source: event.source || 'unknown',
            confidence: event.confidence || 'unknown', timestamp: event.timestamp,
            turn: meta.turn, step: meta.step, value,
          });
        } else {
          invalidSamples.push({ eventId: event.eventId, value: meta.tokenCount, reason: 'tokenCount must be a non-negative safe integer' });
        }
      }
    }
    if (Number.isFinite(meta.contextUsed) && meta.contextUsed >= 0) {
      latestContext = Number(meta.contextUsed);
      latestContextEventId = event.eventId;
      latestContextSource = event.source || 'unknown';
      latestContextConfidence = event.confidence || 'unknown';
    }
    if (Number.isFinite(meta.contextLimit) && meta.contextLimit > 0) {
      latestContextLimit = Number(meta.contextLimit);
      latestContextLimitEventId = event.eventId;
      latestContextLimitSource = event.source || 'unknown';
      latestContextLimitConfidence = event.confidence || 'unknown';
    }
    if (typeof meta.model === 'string' && meta.model) {
      latestModel = meta.model;
      latestModelEventId = event.eventId;
    }
    if (event.eventType === 'session.heartbeat' && Number.isFinite(meta.tokenCount) && validTokenValue(meta.tokenCount)) {
      heartbeatContext = { value: Number(meta.tokenCount), eventId: event.eventId, timestamp: event.timestamp, source: event.source || 'unknown', confidence: event.confidence || 'unknown' };
    }
  }
  for (const key of SOURCE_KEYS) {
    stats[key].coverage = stats[key].outputEnd ? stats[key].withToken / stats[key].outputEnd : 0;
  }
  const hostSamples = samples.filter((sample) => sample.source === 'host-native');
  const derivedSamples = samples.filter((sample) => sample.source === 'derived');
  const simulatedSamples = samples.filter((sample) => sample.source === 'simulated');
  const unknownSamples = samples.filter((sample) => !['host-native', 'derived', 'simulated'].includes(sample.source));
  const hostCoverage = stats['host-native'].coverage;
  const outputAvailable = hostSamples.length > 0;
  const outputStatus = !outputAvailable ? UNAVAILABLE
    : hostCoverage < 1 ? 'PARTIAL_COVERAGE'
      : 'HOST_REPORTED_COMPLETE';
  const outputComplete = outputAvailable && hostCoverage === 1 && stats['host-native'].outputEnd === stats['host-native'].withToken;

  const contextSource = latestContext !== null
    ? latestContextSource
    : heartbeatContext?.source || 'unknown';
  const contextConfidence = latestContext !== null
    ? latestContextConfidence
    : heartbeatContext?.confidence || 'unknown';
  const contextValue = latestContext !== null ? latestContext : (heartbeatContext ? heartbeatContext.value : null);
  const contextStatus = contextValue === null ? UNAVAILABLE : snapshotStatus(contextSource, contextConfidence);
  const limitStatus = latestContextLimit === null ? UNAVAILABLE : snapshotStatus(latestContextLimitSource, latestContextLimitConfidence);
  const field = {
    inputTokens: { value: null, status: UNAVAILABLE, evidence: 'host does not forward inputTokens' },
    outputTokens: {
      value: outputAvailable ? stats['host-native'].sum : null,
      status: outputStatus,
      complete: outputComplete,
      coverage: hostCoverage,
      outputEnd: stats['host-native'].outputEnd,
      withToken: stats['host-native'].withToken,
      sourceStats: stats,
      evidence: 'sum of valid host-native output.end tokenCount; other sources are separate',
    },
    derivedOutputTokens: {
      value: stats.derived.withToken ? stats.derived.sum : null,
      status: stats.derived.withToken ? 'DERIVED' : UNAVAILABLE,
      coverage: stats.derived.coverage,
      outputEnd: stats.derived.outputEnd,
      withToken: stats.derived.withToken,
    },
    simulatedOutputTokens: {
      value: stats.simulated.withToken ? stats.simulated.sum : null,
      status: stats.simulated.withToken ? 'SIMULATED' : UNAVAILABLE,
      coverage: stats.simulated.coverage,
      outputEnd: stats.simulated.outputEnd,
      withToken: stats.simulated.withToken,
    },
    cachedTokens: { value: null, status: UNAVAILABLE, evidence: 'host does not forward cacheRead/cacheWrite tokens' },
    reasoningTokens: { value: null, status: UNAVAILABLE, evidence: 'reasoning usage is not forwarded; no hidden reasoning read' },
    contextUsed: { value: contextValue, status: contextStatus, source: contextSource, confidence: contextConfidence, eventId: latestContext !== null ? latestContextEventId : heartbeatContext?.eventId || '' },
    contextLimit: {
      value: latestContextLimit, status: limitStatus,
      source: latestContextLimitSource, confidence: latestContextLimitConfidence,
      eventId: latestContextLimitEventId,
    },
    ttft: { value: null, status: UNAVAILABLE, evidence: 'no first-token timestamp forwarded' },
    requestId: { value: null, status: UNAVAILABLE, evidence: 'no requestId in metadata allowlist' },
    tokensPerSecond: { value: null, status: UNAVAILABLE, evidence: 'bridge does not calculate tok/s' },
  };
  const snapshot = {
    mode: snapshotMode, at: Number.isFinite(at) ? at : null,
    eventId: cursorEvent?.eventId || '', visibleCount: visible.length,
    model: latestModel, modelEventId: latestModelEventId,
    contextUsed: contextValue, contextEventId: latestContext !== null ? latestContextEventId : heartbeatContext?.eventId || '',
    contextSource, contextStatus,
    contextLimit: latestContextLimit, contextLimitSource: latestContextLimitSource,
  };
  return {
    sessionId, sessionResolution, host: session?.host || '', model: latestModel,
    simulated: simulatedSeen, available: hostSamples.length > 0 || contextValue !== null,
    samples, hostSamples, derivedSamples, simulatedSamples, unknownSamples,
    invalidSamples, sourceStats: stats, snapshot, field,
    limitation: 'Source groups and coverage are separate. Input/cache/reasoning/TTFT/requestId remain UNAVAILABLE.',
  };
}
