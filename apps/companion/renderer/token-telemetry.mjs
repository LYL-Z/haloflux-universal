/**
 * P4.3 token telemetry.
 *
 * Only explicit provider/host fields are accepted. Input/cache/reasoning/TTFT
 * are reported UNAVAILABLE when the host does not forward them; tokenCount is
 * never derived from event count, tool count or text length.
 */
const UNAVAILABLE = 'UNAVAILABLE';

export function buildTokenTelemetry({ events = [], sessions = [], selectedSessionId = '' } = {}) {
  const session = sessions.find((row) => row.sessionId === selectedSessionId) || sessions[0] || null;
  const sessionId = session?.sessionId || selectedSessionId || '';
  const scoped = (Array.isArray(events) ? events : []).filter((event) => !sessionId || event.sessionId === sessionId);
  const seen = new Set();
  const samples = [];
  const contextSnapshots = [];
  let latestContext = null;
  let latestContextLimit = null;
  let model = '';
  let host = '';
  let simulated = false;
  for (const event of scoped) {
    if (!event?.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    host ||= event.host || '';
    model ||= meta.model || '';
    if (event.source === 'simulated') simulated = true;
    if (Number.isFinite(meta.contextUsed)) latestContext = Number(meta.contextUsed);
    if (Number.isFinite(meta.contextLimit)) latestContextLimit = Number(meta.contextLimit);
    // Only assistant/message output.end carries per-message outputTokens.
    // run.end tokenCount is a turn total and heartbeat tokenCount is a
    // cumulative context snapshot; neither may be summed as output.
    if (event.eventType === 'output.end' && Number.isFinite(meta.tokenCount)) {
      samples.push({
        eventId: event.eventId,
        timestamp: event.timestamp,
        value: Number(meta.tokenCount),
        runId: event.metadata?.runId || event.runId || '',
        turn: meta.turn,
        step: meta.step,
        source: event.source || 'unknown',
        confidence: event.confidence || 'unknown',
        model: meta.model || '',
        host: event.host || '',
      });
    }
    if (event.eventType === 'session.heartbeat' && Number.isFinite(meta.tokenCount)) {
      contextSnapshots.push({ eventId: event.eventId, timestamp: event.timestamp, value: Number(meta.tokenCount), source: event.source || 'unknown', confidence: event.confidence || 'unknown' });
    }
  }
  const sessionMetrics = session?.metrics && typeof session.metrics === 'object' ? session.metrics : {};
  if (latestContext === null && Number.isFinite(sessionMetrics.contextUsed)) latestContext = Number(sessionMetrics.contextUsed);
  if (latestContextLimit === null && Number.isFinite(sessionMetrics.contextLimit)) latestContextLimit = Number(sessionMetrics.contextLimit);
  if (!model && typeof sessionMetrics.model === 'string') model = sessionMetrics.model;
  const outputTokens = samples.length ? samples.reduce((sum, row) => sum + row.value, 0) : null;
  const fields = {
    inputTokens: { value: null, status: UNAVAILABLE, evidence: 'host does not forward inputTokens' },
    outputTokens: outputTokens === null
      ? { value: null, status: UNAVAILABLE, evidence: 'no tokenCount on observed events' }
      : { value: outputTokens, status: 'HOST_REPORTED/DERIVED_SUM', evidence: `${samples.length} host-reported tokenCount samples` },
    cachedTokens: { value: null, status: UNAVAILABLE, evidence: 'host does not forward cacheRead/cacheWrite tokens' },
    reasoningTokens: { value: null, status: UNAVAILABLE, evidence: 'reasoning usage is not forwarded; no hidden reasoning read' },
    contextUsed: latestContext === null
      ? { value: null, status: UNAVAILABLE, evidence: 'no contextUsed snapshot' }
      : { value: latestContext, status: 'HOST_REPORTED_SNAPSHOT', evidence: 'latest observed contextUsed / session metric' },
    contextLimit: latestContextLimit === null
      ? { value: null, status: UNAVAILABLE, evidence: 'no contextLimit snapshot' }
      : { value: latestContextLimit, status: 'HOST_REPORTED', evidence: 'latest observed contextLimit' },
    ttft: { value: null, status: UNAVAILABLE, evidence: 'no first-token timestamp forwarded' },
    requestId: { value: null, status: UNAVAILABLE, evidence: 'no requestId in metadata allowlist' },
    tokensPerSecond: { value: null, status: UNAVAILABLE, evidence: 'bridge does not calculate tok/s' },
  };
  return {
    sessionId, host, model, simulated,
    available: Boolean(samples.length || latestContext !== null || latestContextLimit !== null || contextSnapshots.length),
    samples,
    contextSnapshots,
    field: fields,
    limitation: 'Only host-reported tokenCount/contextUsed/contextLimit are shown. Input, cache, reasoning, TTFT and requestId remain UNAVAILABLE.',
  };
}
