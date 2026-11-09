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
    timestamp: numeric(event?.timestamp),
    kind: clean(event?.eventType, 40) || 'unknown',
    tool: clean(event?.toolName, 48),
    host: clean(event?.host, 40),
    source: clean(event?.source, 20) || 'unknown',
  }));
  const toolEvents = safeEvents.filter((event) => typeof event?.eventType === 'string' && event.eventType.startsWith('tool.'));
  const errorEvents = safeEvents.filter((event) => typeof event?.eventType === 'string' && /error|fail/i.test(event.eventType));
  const eventTypes = new Map();
  for (const event of safeEvents) {
    const kind = clean(event?.eventType, 40);
    if (kind) eventTypes.set(kind, (eventTypes.get(kind) || 0) + 1);
  }

  const metrics = session?.metrics || {};
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
      warnings: (Array.isArray(session.warnings) ? session.warnings : []).slice(0, 3).map((x) => clean(x, 64)),
    } : null,
    recent: timeline,
    eventCount: safeEvents.length,
    toolEventCount: toolEvents.length,
    errorEventCount: errorEvents.length,
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
