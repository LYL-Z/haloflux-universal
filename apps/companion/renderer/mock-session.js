/**
 * HALOFLUX renderer — simulated demo stream.
 *
 * Used ONLY when the loopback event bridge is absent (no token / unreachable)
 * or when the user explicitly opens the demo (`?demo=1` / `?mock=1`). Every
 * session produced here carries `source: 'simulated'` and `confidence:
 * 'unverified'`; the renderer additionally shows the「示例数据 · SIMULATED」
 * watermark. Nothing in this file may be presented as a live host state.
 *
 * The stream intentionally mirrors the bridge's `GET /v1/state` / SSE snapshot
 * shape (schemaVersion, serverTime, activeSessionId, hosts, sessions, bridge)
 * so the renderer has exactly one data path.
 */

const HOSTS = [
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    short: 'DS',
    version: '0.2.1-rc.5',
    capabilities: { sessionStart: true, toolUse: true, tokenMetrics: true, approval: true, outputStream: true },
    warnings: [],
  },
  {
    id: 'codex',
    name: 'Codex',
    short: 'CX',
    version: '0.154.0',
    capabilities: { sessionStart: true, toolUse: true, tokenMetrics: true, approval: false, outputStream: false },
    warnings: [],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    short: 'CU',
    version: '3.29.9',
    capabilities: { sessionStart: true, toolUse: true, tokenMetrics: false, approval: false, outputStream: false },
    warnings: ['no-token-metrics'],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    short: 'WB',
    version: '5.9.3',
    capabilities: { sessionStart: true, toolUse: true, tokenMetrics: false, approval: false, outputStream: false },
    warnings: ['no-native-output-events'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    short: 'CC',
    version: '2.1.299',
    capabilities: { sessionStart: true, toolUse: true, tokenMetrics: false, approval: true, outputStream: false },
    warnings: ['no-token-metrics', 'no-native-output-events'],
  },
  {
    id: 'trae',
    name: 'TRAE',
    short: 'TR',
    version: '3.4.13',
    capabilities: { sessionStart: true, toolUse: false, tokenMetrics: false, approval: false, outputStream: false },
    warnings: ['no-tool-events'],
  },
];

const HOST_BY_ID = new Map(HOSTS.map((host) => [host.id, host]));

export const MOCK_STATES = Object.freeze([
  'running',
  'tool',
  'output',
  'waiting_approval',
  'done',
  'idle',
  'error',
  'unknown',
  'connected',
  'disconnected',
]);

export const MOCK_HOSTS = HOSTS;

const STATE_SEQUENCE = Object.freeze([
  'running',
  'tool',
  'output',
  'waiting_approval',
  'running',
  'done',
  'idle',
  'error',
  'unknown',
  'connected',
  'disconnected',
]);

const EVENT_FOR_STATE = Object.freeze({
  disconnected: 'session.end',
  connected: 'session.start',
  idle: 'run.end',
  running: 'task.received',
  tool: 'tool.start',
  output: 'output.start',
  waiting_approval: 'approval.request',
  done: 'run.end',
  error: 'error',
  unknown: 'session.heartbeat',
});

const TOOL_NAMES = Object.freeze(['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'WebFetch']);
const SECONDARY_STATES = Object.freeze({
  codex: 'running',
  cursor: 'waiting_approval',
  workbuddy: 'tool',
  trae: 'idle',
  'deepseek-harness': 'idle',
});

/** Small deterministic PRNG so demo captures are stable enough to compare. */
function makeRng(seed) {
  let value = seed >>> 0;
  return function rng() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function eventLabel(eventType, toolName) {
  if (eventType === 'tool.start' && toolName) return toolName;
  return undefined;
}

function eventTypeFor(state) {
  return EVENT_FOR_STATE[state] || 'state.snapshot';
}

function cloneSession(session) {
  return {
    ...session,
    metrics: { ...session.metrics },
    warnings: session.warnings ? session.warnings.slice() : [],
    recentEvents: session.recentEvents.map((event) => ({ ...event })),
  };
}

/**
 * Create a simulated snapshot stream.
 *
 * @param {object} options
 * @param {boolean} [options.multi] include all six hosts (default: four)
 * @param {string} [options.initialState] pin one of the ten states
 * @param {number} [options.intervalMs] state cycle interval (default 3200)
 * @param {(snapshot:object)=>void} [options.onSnapshot]
 */
export function createMockStream(options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(500, options.intervalMs) : 3200;
  const multi = options.multi === true;
  const rng = makeRng(0x51f0c0de);
  const startedAt = Date.now();

  let stopped = false;
  let timer = null;
  let pinned = false;
  let sequenceIndex = 0;
  let step = 3;
  let turn = 1;
  let toolName = 'Bash';
  let tickCount = 0;
  let pinnedState = null;
  if (options.initialState && EVENT_FOR_STATE[options.initialState]) {
    pinned = true;
    pinnedState = options.initialState;
    sequenceIndex = Math.max(0, STATE_SEQUENCE.indexOf(options.initialState));
  }

  const primaryHost = HOST_BY_ID.get('claude-code');
  const sessionStarts = new Map();

  function newSession(hostId, state) {
    const host = HOST_BY_ID.get(hostId);
    const sessionId = `${hostId}:demo-${host.short.toLowerCase()}-01`;
    const started = startedAt - 1000 * 60 * (6 + Math.round(rng() * 20));
    sessionStarts.set(sessionId, started);
    return {
      sessionId,
      host: hostId,
      hostVersion: host.version,
      state,
      reportedState: state,
      source: 'simulated',
      confidence: 'unverified',
      connected: state !== 'disconnected',
      lastEventAt: Date.now(),
      startedAt: started,
      metrics: {
        step: 1 + Math.round(rng() * 4),
        turn,
        model: hostId === 'claude-code' ? 'claude-opus-4-5' : hostId === 'codex' ? 'gpt-5.4-codex' : hostId === 'deepseek-harness' ? 'deepseek-v4' : '',
        sessionTitle: hostId === 'claude-code' ? 'HALOFLUX × Claude Code' : hostId === 'codex' ? 'Bridge adapter review' : 'Simulated session',
        projectName: hostId === 'claude-code' ? 'haloflux-universal' : 'haloflux',
      },
      warnings: host.warnings.slice(),
      recentEvents: [],
    };
  }

  const sessions = new Map();
  sessions.set('claude-code', newSession('claude-code', pinned ? pinnedState : 'running'));
  sessions.set('codex', newSession('codex', SECONDARY_STATES.codex));
  sessions.set('cursor', newSession('cursor', SECONDARY_STATES.cursor));
  if (multi) {
    sessions.set('workbuddy', newSession('workbuddy', SECONDARY_STATES.workbuddy));
    sessions.set('trae', newSession('trae', SECONDARY_STATES.trae));
    sessions.set('deepseek-harness', newSession('deepseek-harness', SECONDARY_STATES['deepseek-harness']));
  }

  function primarySession() {
    return sessions.get('claude-code');
  }

  function pushEvent(session, eventType, at, name) {
    const event = {
      eventType,
      timestamp: at,
      ...(name ? { toolName: name } : {}),
    };
    session.recentEvents.push(event);
    if (session.recentEvents.length > 40) session.recentEvents.splice(0, session.recentEvents.length - 40);
    session.lastEventAt = at;
  }

  function seedHistory(session, state, offset) {
    const now = Date.now();
    pushEvent(session, 'session.start', now - 9000 - offset);
    if (state !== 'connected' && state !== 'disconnected') {
      pushEvent(session, 'task.received', now - 7200 - offset);
    }
    if (state === 'tool' || state === 'waiting_approval' || state === 'error') {
      pushEvent(session, 'tool.start', now - 1200 - offset, state === 'error' ? 'Bash' : toolName);
    }
    if (state === 'output') {
      pushEvent(session, 'output.start', now - 900 - offset);
    }
    pushEvent(session, eventTypeFor(state), now - 120 - offset, eventTypeFor(state) === 'tool.start' ? toolName : undefined);
  }

  seedHistory(primarySession(), primarySession().state, 0);
  for (const [hostId, session] of sessions) {
    if (hostId === 'claude-code') continue;
    seedHistory(session, session.state, 40);
  }

  function applyPrimaryState(state) {
    const session = primarySession();
    session.state = state;
    session.reportedState = state;
    session.connected = state !== 'disconnected';
    session.lastEventAt = Date.now();
    if (state === 'tool' || state === 'waiting_approval') {
      toolName = TOOL_NAMES[tickCount % TOOL_NAMES.length];
      session.metrics.toolName = toolName;
    } else if (state === 'error') {
      session.metrics.toolName = toolName;
    } else {
      delete session.metrics.toolName;
    }
    if (state === 'running' || state === 'output' || state === 'tool') {
      step += 1;
      session.metrics.step = step;
    }
    if (state === 'done') {
      turn += 1;
      session.metrics.turn = turn;
    }
    const eventType = eventTypeFor(state);
    pushEvent(session, eventType, Date.now(), eventType === 'tool.start' ? toolName : undefined);
  }

  // Initial/pinned states must carry the same metadata an evolved state would:
  // otherwise a "tool" capture shows an empty TOOL metric (and no engine tool
  // beam) even though the session claims it is running a tool.
  (function hydrateInitialState() {
    const primary = primarySession();
    if (primary.state === 'tool' || primary.state === 'waiting_approval' || primary.state === 'error') {
      primary.metrics.toolName = toolName;
    }
    if (primary.state === 'running' || primary.state === 'output' || primary.state === 'tool') {
      primary.metrics.step = step;
    }
    const workbuddy = sessions.get('workbuddy');
    if (workbuddy && workbuddy.state === 'tool') workbuddy.metrics.toolName = 'Grep';
  })();

  function updateSecondary() {
    // One extra event per tick from an existing secondary session keeps the feed
    // varied without ever touching the primary session's reported state.
    const hosts = multi ? ['codex', 'cursor', 'workbuddy', 'deepseek-harness'] : ['codex', 'cursor'];
    const hostId = hosts[tickCount % hosts.length];
    const session = sessions.get(hostId);
    if (!session) return;
    const state = session.state;
    const eventType = eventTypeFor(state);
    pushEvent(session, eventType, Date.now(), eventType === 'tool.start' ? 'Grep' : undefined);
    session.lastEventAt = Date.now();
  }

  function buildSnapshot() {
    const primary = primarySession();
    const hostList = HOSTS.filter((host) => multi || ['claude-code', 'codex', 'cursor'].includes(host.id));
    return {
      schemaVersion: 1,
      serverTime: Date.now(),
      activeSessionId: primary.sessionId,
      hosts: hostList.map((host) => {
        const session = sessions.get(host.id);
        return {
          host: host.id,
          hostVersion: host.version,
          connected: !!session && session.connected,
          lastSeen: session ? session.lastEventAt : startedAt,
          capabilities: { ...host.capabilities },
          note: 'simulated demo data',
        };
      }),
      sessions: Array.from(sessions.values()).map(cloneSession),
      bridge: {
        version: '0.1.0-mock',
        uptimeMs: Date.now() - startedAt,
        eventCount: Array.from(sessions.values()).reduce((sum, session) => sum + session.recentEvents.length, 0),
        dropped: 0,
        simulated: true,
      },
    };
  }

  function emit() {
    if (typeof options.onSnapshot === 'function') {
      try {
        options.onSnapshot(buildSnapshot());
      } catch {
        /* a renderer callback must not kill the demo timer */
      }
    }
  }

  function tick() {
    if (stopped || pinned) return;
    tickCount += 1;
    sequenceIndex = (sequenceIndex + 1) % STATE_SEQUENCE.length;
    applyPrimaryState(STATE_SEQUENCE[sequenceIndex]);
    updateSecondary();
    emit();
  }

  return {
    start() {
      if (stopped) return;
      emit();
      if (!pinned && timer === null) {
        timer = setInterval(tick, intervalMs);
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    /** Pin a state for deterministic QA/capture; stops the cycle. */
    setState(state) {
      if (stopped || !EVENT_FOR_STATE[state]) return false;
      pinned = true;
      pinnedState = state;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      applyPrimaryState(state);
      emit();
      return true;
    },
    getPinnedState() {
      return pinned ? pinnedState : null;
    },
    getSnapshot: buildSnapshot,
  };
}
