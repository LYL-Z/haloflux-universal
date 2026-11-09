/**
 * Read-only, content-free projection of the event bridge into Paper Lab cells.
 * No model reasoning, prompt text, document contents, or inferred successes.
 */

const RECENT_LIMIT = 8;

function clean(value, limit = 64) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function projectMonitor({ hosts = [], sessions = [], events = [], selectedSessionId = null, mode = 'connecting' } = {}) {
  const safeHosts = Array.isArray(hosts) ? hosts : [];
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const safeEvents = Array.isArray(events) ? events : [];
  const session = safeSessions.find((item) => item?.sessionId === selectedSessionId) || null;
  const byHost = new Map();
  for (const current of safeSessions) {
    if (!current || typeof current.host !== 'string') continue;
    if (!byHost.has(current.host)) byHost.set(current.host, current);
  }

  const timeline = safeEvents.slice(-RECENT_LIMIT).reverse().map((event) => ({
    key: `${clean(event?.sessionId, 64)}|${event?.timestamp ?? ''}|${clean(event?.eventType, 40)}|${clean(event?.toolCallId, 64)}`,
    timestamp: numeric(event?.timestamp),
    kind: clean(event?.eventType, 40) || 'unknown',
    tool: clean(event?.toolName, 48),
    host: clean(event?.host, 40),
    sessionId: clean(event?.sessionId, 64),
    toolCallId: clean(event?.toolCallId, 64),
    durationMs: numeric(event?.durationMs),
    errorCode: clean(event?.errorCode, 64),
    source: clean(event?.source, 20) || 'unknown',
    confidence: clean(event?.confidence, 32) || 'unknown',
  }));
  const toolEvents = safeEvents.filter((event) => typeof event?.eventType === 'string' && event.eventType.startsWith('tool.'));
  const errorEvents = safeEvents.filter((event) => typeof event?.eventType === 'string' && /error|fail/i.test(event.eventType));
  const eventTypes = new Map();
  for (const event of safeEvents) {
    const kind = clean(event?.eventType, 40);
    if (kind) eventTypes.set(kind, (eventTypes.get(kind) || 0) + 1);
  }

  // Correlation is per selected session only. A tool.end from another session
  // must never populate this session's duration or call id.
  const selectedEvents = session
    ? safeEvents.filter((event) => event && event.sessionId === session.sessionId)
    : [];
  const selectedToolEvents = selectedEvents.filter((event) => typeof event?.eventType === 'string' && event.eventType.startsWith('tool.'));
  const lastTool = [...selectedEvents].reverse().find((event) => event && (event.eventType === 'tool.end' || event.eventType === 'tool.fail'));
  const metrics = session?.metrics || {};
  let toolCallId = clean(metrics.lastToolCallId, 64) || (lastTool ? clean(lastTool.toolCallId, 64) : '');
  let toolCorrelated = metrics.lastToolCorrelated === true;
  let toolDurationMs = numeric(metrics.lastToolDurationMs);

  // SessionManager is authoritative when it has a verdict. Only reconstruct a
  // match from cached events when the manager gave no verdict at all.
  if (metrics.lastToolCorrelated === undefined && lastTool && lastTool.toolCallId) {
    const start = [...selectedEvents].reverse().find(
      (event) => event && event.eventType === 'tool.start' && event.toolCallId === lastTool.toolCallId,
    );
    if (start) {
      toolCorrelated = true;
      toolDurationMs = numeric(lastTool.durationMs) ?? Math.max(0, (lastTool.timestamp || 0) - (start.timestamp || 0));
    }
  }
  if (toolCorrelated && toolDurationMs === null && lastTool && lastTool.toolCallId === toolCallId) {
    toolDurationMs = numeric(lastTool.durationMs);
  }
  if (!toolCorrelated) toolDurationMs = null;

  return {
    mode: clean(mode, 20),
    sessionCount: safeSessions.length,
    observedHostCount: byHost.size,
    hostCount: safeHosts.length,
    selected: session ? {
      host: clean(session.host, 64),
      state: clean(session.state, 32),
      source: clean(session.source, 32),
      confidence: clean(session.confidence, 32),
      model: clean(metrics.model, 64),
      toolName: clean(metrics.toolName, 48),
      step: numeric(metrics.step),
      turn: numeric(metrics.turn),
      tokensPerSecond: numeric(metrics.tokensPerSecond),
      contextUsed: numeric(metrics.contextUsed),
      contextLimit: numeric(metrics.contextLimit),
      lastToolDurationMs: toolDurationMs,
      lastToolCallId: toolCallId,
      lastToolCorrelated: toolCorrelated,
      selectedToolEventCount: selectedToolEvents.length,
      selectedEventCount: selectedEvents.length,
      warnings: (Array.isArray(session.warnings) ? session.warnings : []).slice(0, 3).map((x) => clean(x, 64)),
    } : null,
    recent: timeline,
    eventCount: safeEvents.length,
    toolEventCount: toolEvents.length,
    errorEventCount: errorEvents.length,
    selectedEventCount: selectedEvents.length,
    selectedToolEventCount: selectedToolEvents.length,
    toolDurationMs,
    toolCorrelated,
    types: [...eventTypes].sort((a, b) => b[1] - a[1]).slice(0, 5),
    hosts: safeHosts.map((host) => {
      const current = byHost.get(host.id);
      return {
        id: clean(host.id, 64),
        short: clean(host.short, 8),
        state: clean(current?.state || 'disconnected', 32),
        source: clean(current?.source || '', 20),
        count: safeSessions.filter((item) => item?.host === host.id).length,
        selected: session?.host === host.id,
      };
    }),
  };
}
