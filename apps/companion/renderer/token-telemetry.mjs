/**
 * P4.3-R1 token telemetry.
 *
 * Truth rules:
 *  - only output.end carries per-message output tokens;
 *  - run.end turn totals and heartbeat context snapshots are never added to
 *    output tokens;
 *  - real/simulated/derived samples are separate groups and never mixed into a
 *    single "real total";
 *  - coverage is explicit; incomplete coverage is not labelled complete;
 *  - a missing/unknown session never falls back to another session;
 *  - snapshots are selected by timestamp, not by traversal order.
 */
const UNAVAILABLE = 'UNAVAILABLE';

function validTokenValue(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
}

export function buildTokenTelemetry({
  events = [], sessions = [], selectedSessionId = '',
  snapshotTimestamp = null, snapshotMode = 'current',
} = {}) {
  let session = null;
  let sessionResolution = 'EMPTY';
  if (selectedSessionId !== undefined && selectedSessionId !== null && selectedSessionId !== '') {
    session = sessions.find((row) => row.sessionId === selectedSessionId) || null;
    sessionResolution = session ? 'FOUND' : 'MISSING';
  }
  // A missing explicit session returns no data; it must not borrow sessions[0].
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
  const visible = ordered.filter((event) => Number.isFinite(event.timestamp) && event.timestamp <= at);
  const cursorEvent = visible.length ? visible[visible.length - 1] : null;

  const seen = new Set();
  const samples = [];
  const invalidSamples = [];
  let outputEndTotal = 0;
  let outputEndWithToken = 0;
  let heartbeatContext = null;
  let latestContext = null;
  let latestContextLimit = null;
  let latestModel = '';
  let latestModelEventId = '';
  let latestContextEventId = '';
  let latestContextSource = 'unknown';
  let simulatedSeen = false;

  for (const event of visible) {
    if (!event?.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    if (event.source === 'simulated') simulatedSeen = true;
    if (event.eventType === 'output.end') {
      outputEndTotal += 1;
      if (meta.tokenCount !== undefined && meta.tokenCount !== null) {
        if (validTokenValue(meta.tokenCount)) {
          outputEndWithToken += 1;
          samples.push({
            eventId: event.eventId,
            sessionId: event.sessionId || '',
            runId: event.metadata?.runId || event.runId || '',
            host: event.host || '',
            model: meta.model || '',
            source: event.source || 'unknown',
            confidence: event.confidence || 'unknown',
            timestamp: event.timestamp,
            turn: meta.turn,
            step: meta.step,
            value: Number(meta.tokenCount),
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
    }
    if (Number.isFinite(meta.contextLimit) && meta.contextLimit > 0) latestContextLimit = Number(meta.contextLimit);
    if (typeof meta.model === 'string' && meta.model) {
      latestModel = meta.model;
      latestModelEventId = event.eventId;
    }
    if (event.eventType === 'session.heartbeat' && Number.isFinite(meta.tokenCount) && validTokenValue(meta.tokenCount)) {
      heartbeatContext = { value: Number(meta.tokenCount), eventId: event.eventId, timestamp: event.timestamp, source: event.source || 'unknown', confidence: event.confidence || 'unknown' };
    }
  }

  const hostSamples = samples.filter((sample) => sample.source === 'host-native');
  const derivedSamples = samples.filter((sample) => sample.source === 'derived');
  const simulatedSamples = samples.filter((sample) => sample.source === 'simulated');
  const unknownSamples = samples.filter((sample) => !['host-native', 'derived', 'simulated'].includes(sample.source));
  const realSamples = [...hostSamples, ...derivedSamples];
  const realCoverage = outputEndTotal === 0 ? 0 : outputEndWithToken / outputEndTotal;
  const outputAvailable = hostSamples.length > 0;
  const outputStatus = !outputAvailable ? UNAVAILABLE
    : realCoverage < 1 ? 'PARTIAL_COVERAGE'
      : 'HOST_REPORTED_COMPLETE';
  const contextValue = latestContext ?? (heartbeatContext ? heartbeatContext.value : null);
  const contextStatus = contextValue === null ? UNAVAILABLE
    : latestContextSource === 'simulated' || (!latestContext && heartbeatContext?.source === 'simulated') ? 'SIMULATED_SNAPSHOT'
      : latestContextSource === 'derived' || (!latestContext && heartbeatContext?.source === 'derived') ? 'DERIVED_SNAPSHOT'
        : 'HOST_REPORTED_SNAPSHOT';
  const snapshot = {
    mode: snapshotMode,
    at: Number.isFinite(at) ? at : null,
    eventId: cursorEvent?.eventId || '',
    model: latestModel,
    modelEventId: latestModelEventId,
    contextUsed: contextValue,
    contextEventId: latestContextEventId || heartbeatContext?.eventId || '',
    contextSource: latestContextSource,
    contextStatus,
    contextLimit: latestContextLimit,
  };
  const field = {
    inputTokens: { value: null, status: UNAVAILABLE, evidence: 'host does not forward inputTokens' },
    outputTokens: {
      value: outputAvailable ? hostSamples.reduce((sum, sample) => sum + sample.value, 0) : null,
      status: outputStatus,
      observedSamples: samples.length,
      hostSamples: hostSamples.length,
      derivedSamples: derivedSamples.length,
      simulatedSamples: simulatedSamples.length,
      unknownSamples: unknownSamples.length,
      outputEndTotal,
      outputEndWithToken,
      coverage: realCoverage,
      complete: realCoverage === 1 && hostSamples.length === outputEndTotal,
      evidence: 'sum of valid host-native output.end tokenCount; simulated/derived are separate groups',
    },
    simulatedOutputTokens: {
      value: simulatedSamples.length ? simulatedSamples.reduce((sum, sample) => sum + sample.value, 0) : null,
      status: simulatedSamples.length ? 'SIMULATED' : UNAVAILABLE,
      samples: simulatedSamples.length,
    },
    cachedTokens: { value: null, status: UNAVAILABLE, evidence: 'host does not forward cacheRead/cacheWrite tokens' },
    reasoningTokens: { value: null, status: UNAVAILABLE, evidence: 'reasoning usage is not forwarded; no hidden reasoning read' },
    contextUsed: { value: contextValue, status: contextStatus, evidence: 'latest explicit snapshot at/before cursor; heartbeat only if no explicit contextUsed' },
    contextLimit: latestContextLimit === null ? { value: null, status: UNAVAILABLE } : { value: latestContextLimit, status: 'HOST_REPORTED' },
    ttft: { value: null, status: UNAVAILABLE, evidence: 'no first-token timestamp forwarded' },
    requestId: { value: null, status: UNAVAILABLE, evidence: 'no requestId in metadata allowlist' },
    tokensPerSecond: { value: null, status: UNAVAILABLE, evidence: 'bridge does not calculate tok/s' },
  };
  return {
    sessionId,
    sessionResolution,
    host: session?.host || '',
    model: latestModel,
    simulated: simulatedSeen,
    available: hostSamples.length > 0 || contextValue !== null,
    coverage: realCoverage,
    samples,
    hostSamples,
    derivedSamples,
    simulatedSamples,
    unknownSamples,
    invalidSamples,
    snapshot,
    field,
    limitation: 'Real, derived and simulated samples are separate. Input/cache/reasoning/TTFT/requestId remain UNAVAILABLE. Coverage is reported; incomplete coverage is not a complete total.',
  };
}
