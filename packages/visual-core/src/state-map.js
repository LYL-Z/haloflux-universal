/**
 * HALOFLUX Universal Agent Visualizer — SessionView → visual state mapping.
 *
 * This module is deliberately pure: no DOM, no engine instance, no clock. The
 * visualizer feeds it the normalized SessionView from the event bridge and gets
 * back (a) an engine "live" shim, (b) sparse visual parameter overrides and
 * (c) the labels the HUD needs. That separation is what lets the unit tests
 * assert the contract mapping for all ten states without a canvas.
 *
 * Truthfulness rules encoded here:
 *   - `source` and `confidence` are never collapsed into one "connected" label.
 *   - `simulated` is a first-class visual state, not a normal session that was
 *     recoloured: it exposes `simulated: true` and the renderer MUST watermark it.
 *   - token/context metrics are only forwarded when the bridge supplied them.
 *     Missing numbers stay missing (`undefined`), never zero-filled into fake data.
 *   - `thinking` is never inferred. A running loop is not the same as a host
 *     reporting that the model is thinking.
 */

export const AGENT_STATES = Object.freeze([
  'disconnected',
  'connected',
  'idle',
  'running',
  'tool',
  'output',
  'waiting_approval',
  'done',
  'error',
  'unknown',
]);

export const EVENT_SOURCES = Object.freeze(['host-native', 'derived', 'simulated']);
export const CONFIDENCE_LEVELS = Object.freeze(['confirmed', 'inferred', 'unverified']);

/** States where the agent is doing work (drives the ring envelope). */
export const ACTIVE_STATES = Object.freeze([
  'running',
  'tool',
  'output',
  'waiting_approval',
  'error',
]);

/**
 * Per-state identity. `color` is intentionally muted: the product brief bans
 * cheap neon, so these read as instrument-panel LEDs, not arcade lights.
 */
export const STATE_META = Object.freeze({
  disconnected: Object.freeze({
    labelZh: '已断开', labelEn: 'Disconnected', short: '断开', color: '#66707f',
    ringZh: '低亮静止', ringEn: 'dim and static', severity: 9, active: false,
  }),
  connected: Object.freeze({
    labelZh: '已连接', labelEn: 'Connected', short: '连接', color: '#8195ad',
    ringZh: '缓慢呼吸', ringEn: 'slow breathing', severity: 6, active: false,
  }),
  idle: Object.freeze({
    labelZh: '空闲', labelEn: 'Idle', short: '空闲', color: '#7fa8a0',
    ringZh: '空闲呼吸', ringEn: 'idle breathing', severity: 7, active: false,
  }),
  running: Object.freeze({
    labelZh: '运行中', labelEn: 'Running', short: '运行', color: '#7aa7d9',
    ringZh: '持续旋转', ringEn: 'continuous rotation', severity: 4, active: true,
  }),
  tool: Object.freeze({
    labelZh: '调用工具', labelEn: 'Tool', short: '工具', color: '#d3a96f',
    ringZh: '外围光束 + 数据块', ringEn: 'outer beams + data blocks', severity: 2, active: true,
  }),
  output: Object.freeze({
    labelZh: '输出中', labelEn: 'Output', short: '输出', color: '#6fc0cf',
    ringZh: '流动光环', ringEn: 'flowing ring', severity: 3, active: true,
  }),
  waiting_approval: Object.freeze({
    labelZh: '等待确认', labelEn: 'Waiting approval', short: '待确认', color: '#d99554',
    ringZh: '明显等待脉冲', ringEn: 'strong waiting pulse', severity: 1, active: true,
  }),
  done: Object.freeze({
    labelZh: '已完成', labelEn: 'Done', short: '完成', color: '#80b894',
    ringZh: '收束回空闲', ringEn: 'collapse back to idle', severity: 8, active: false,
  }),
  error: Object.freeze({
    labelZh: '错误', labelEn: 'Error', short: '错误', color: '#d3766f',
    ringZh: '局部故障 + 钉住', ringEn: 'localised glitch + pinned', severity: 0, active: true,
  }),
  unknown: Object.freeze({
    labelZh: '未知', labelEn: 'Unknown', short: '未知', color: '#918bb0',
    ringZh: '黯淡虚线相位环', ringEn: 'subdued dashed phase ring', severity: 10, active: false,
  }),
});

export const SOURCE_META = Object.freeze({
  'host-native': Object.freeze({
    labelZh: '宿主原生', labelEn: 'host-native', short: '原生',
    descriptionZh: '由宿主官方扩展点直接上报', descriptionEn: 'Reported by the host’s official extension point',
  }),
  derived: Object.freeze({
    labelZh: '推断', labelEn: 'derived', short: '推断',
    descriptionZh: '来自只读日志 / 心跳推导，可能滞后', descriptionEn: 'Derived from read-only logs / heartbeats; may lag',
  }),
  simulated: Object.freeze({
    labelZh: '模拟', labelEn: 'simulated', short: '模拟',
    descriptionZh: '演示数据，不是真机状态', descriptionEn: 'Demo data — not a real host session',
  }),
});

export const CONFIDENCE_META = Object.freeze({
  confirmed: Object.freeze({ labelZh: '确认', labelEn: 'confirmed', short: '确认' }),
  inferred: Object.freeze({ labelZh: '推断', labelEn: 'inferred', short: '推断' }),
  unverified: Object.freeze({ labelZh: '未验证', labelEn: 'unverified', short: '未验证' }),
});

const METRIC_STRING_KEYS = Object.freeze([
  'toolName', 'model', 'projectName', 'sessionTitle',
]);
const METRIC_NUMBER_KEYS = Object.freeze([
  'step', 'turn', 'tokenCount', 'tokensPerSecond', 'contextUsed', 'contextLimit',
]);

/** Sparse parameter overrides per state. Absent keys leave the preset value. */
const STATE_PARAMS = Object.freeze({
  disconnected: Object.freeze({
    idleMotion: 0.05, voidLevel: 0.05, runLevel: 0.5, tempo: 0.25, ringSpeed: 0.2,
    motionQuiet: 0.85, glow: 0.55, cometPerBeat: 0, cometBurst: 0, cometTrickle: 0,
    beamBright: 0.2, dashBright: 0.2, phaseRing: 0, errFx: 0,
  }),
  connected: Object.freeze({
    idleMotion: 0.34, runLevel: 0.9, tempo: 0.75, ringSpeed: 0.6, motionQuiet: 0.25,
    cometPerBeat: 0.5, cometBurst: 2, beamBright: 0.6, dashBright: 0.6,
  }),
  idle: Object.freeze({
    idleMotion: 0.45, runLevel: 0.9, tempo: 0.8, ringSpeed: 0.65, motionQuiet: 0.25,
    cometPerBeat: 0.5, cometBurst: 2,
  }),
  running: Object.freeze({
    runLevel: 1, tempo: 1.05, ringSpeed: 1.05, motionQuiet: 0, phaseRing: 1,
  }),
  tool: Object.freeze({
    runLevel: 1.05, tempo: 1.1, ringSpeed: 0.95, motionQuiet: 0, toolBeam: 1,
    phaseRing: 1, beamBright: 1.4, cometPerBeat: 1.6, cometBurst: 6,
  }),
  output: Object.freeze({
    runLevel: 1.05, tempo: 1, ringSpeed: 1.1, motionQuiet: 0, cometTrickle: 1.5,
    dashBright: 1.4, phaseRing: 1,
  }),
  waiting_approval: Object.freeze({
    runLevel: 0.7, tempo: 0.5, ringSpeed: 0.35, motionQuiet: 0.55,
    cometPerBeat: 0.3, cometBurst: 0, cometTrickle: 0, glow: 1.15, phaseRing: 1,
  }),
  done: Object.freeze({
    idleMotion: 0.32, runLevel: 0.5, tempo: 0.7, ringSpeed: 0.6, releaseMs: 900, phaseRing: 0,
  }),
  error: Object.freeze({
    runLevel: 0.85, tempo: 0.65, ringSpeed: 0.55, motionQuiet: 0.35,
    errFx: 1, errPin: 1, glitchAmt: 0.7, phaseRing: 1,
  }),
  unknown: Object.freeze({
    idleMotion: 0.28, runLevel: 0.4, tempo: 0.55, ringSpeed: 0.45, motionQuiet: 0.55,
    phaseRing: 1, cometTrickle: 0,
  }),
});

/** Activity 0..1 handed to the engine's generation-rate field (not brightness). */
const STATE_ACTIVITY = Object.freeze({
  disconnected: 0,
  connected: 0.04,
  idle: 0.08,
  running: 1,
  tool: 1,
  output: 1,
  waiting_approval: 0.35,
  done: 0.5,
  error: 0.7,
  unknown: 0.06,
});

const SOURCE_KEYS = new Set(EVENT_SOURCES);
const CONFIDENCE_KEYS = new Set(CONFIDENCE_LEVELS);
const STATE_KEYS = new Set(AGENT_STATES);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function clampText(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/**
 * Coerce an untrusted bridge snapshot into the exact SessionView shape.
 * Unknown enum values degrade to `unknown` / `derived` / `unverified`; they are
 * never silently upgraded to a confident host-native claim.
 */
export function normalizeSession(view) {
  if (!isObject(view)) return undefined;

  const state = STATE_KEYS.has(view.state) ? view.state : 'unknown';
  const reportedState = STATE_KEYS.has(view.reportedState) ? view.reportedState : state;
  const source = SOURCE_KEYS.has(view.source) ? view.source : 'derived';
  const confidence = CONFIDENCE_KEYS.has(view.confidence) ? view.confidence : 'unverified';

  const rawMetrics = isObject(view.metrics) ? view.metrics : {};
  const metrics = {};
  for (const key of METRIC_STRING_KEYS) {
    if (typeof rawMetrics[key] === 'string' && rawMetrics[key].length > 0) {
      metrics[key] = clampText(rawMetrics[key], 160);
    }
  }
  for (const key of METRIC_NUMBER_KEYS) {
    const value = finiteOrUndefined(rawMetrics[key]);
    if (value !== undefined) metrics[key] = value;
  }

  const recentEvents = Array.isArray(view.recentEvents)
    ? view.recentEvents
      .filter((event) => isObject(event) && typeof event.eventType === 'string')
      .slice(-200)
      .map((event) => ({
        eventType: clampText(event.eventType, 40),
        timestamp: finiteOrUndefined(event.timestamp) ?? 0,
        ...(typeof event.toolName === 'string' && event.toolName ? { toolName: clampText(event.toolName, 80) } : {}),
        ...(typeof event.label === 'string' && event.label ? { label: clampText(event.label, 120) } : {}),
      }))
    : [];

  const warnings = Array.isArray(view.warnings)
    ? view.warnings.filter((warning) => typeof warning === 'string').slice(0, 12).map((warning) => clampText(warning, 120))
    : [];

  return {
    sessionId: clampText(view.sessionId, 128) || 'unknown-session',
    host: clampText(view.host, 64) || 'generic',
    hostVersion: clampText(view.hostVersion, 64),
    state,
    reportedState,
    source,
    confidence,
    connected: view.connected === true,
    lastEventAt: finiteOrUndefined(view.lastEventAt) ?? 0,
    startedAt: finiteOrUndefined(view.startedAt) ?? 0,
    metrics,
    recentEvents,
    warnings,
  };
}

/** Build the mutable `live` object the upstream engine reads every frame. */
export function toEngineLive(session) {
  const view = normalizeSession(session);
  const state = view ? view.state : 'disconnected';
  const metrics = view ? view.metrics : {};
  const toolName = metrics.toolName;
  const toolId = view ? `${view.sessionId}:${metrics.step ?? 0}:${toolName || state}` : '';

  const tools = [];
  if (view && (state === 'tool' || (state === 'error' && toolName))) {
    tools.push({
      id: toolId,
      name: clampText(toolName || (state === 'error' ? 'error' : 'tool'), 40),
      state: state === 'error' ? 'error' : 'running',
    });
  }

  const live = {
    // `sessionPresent: false` is the engine's void level: no session at all.
    sessionPresent: state !== 'disconnected',
    running: ACTIVE_STATES.includes(state),
    activity: STATE_ACTIVITY[state] ?? 0,
    // Never invent thinking/streaming: output is the only reported flow state.
    thinking: false,
    streaming: state === 'output',
    tools,
    // Zero is the engine's "absent" sentinel; the HUD shows the same value as "—".
    tps: metrics.tokensPerSecond ?? 0,
    totalTokens: metrics.tokenCount ?? 0,
    contextTokens: metrics.contextUsed ?? 0,
    contextLimit: metrics.contextLimit ?? 0,
    step: metrics.step ?? 0,
    turn: metrics.turn ?? 0,
    stepsDone: metrics.step ?? 0,
    model: metrics.model ?? '',
    lastToolAt: state === 'tool' ? 1 : 0,
  };
  return live;
}

/**
 * SessionView → visual profile.
 *
 * Returns a plain object (not frozen) because the visualizer stamps mutable
 * transition bookkeeping (`changedAt`, `flareAt`) onto it.
 */
export function stateVisual(view, now = 0) {
  const session = normalizeSession(view);
  if (!session) {
    return {
      sessionId: '',
      host: '',
      hostVersion: '',
      state: 'disconnected',
      reportedState: 'disconnected',
      source: 'derived',
      confidence: 'unverified',
      simulated: false,
      inferred: true,
      confirmed: false,
      connected: false,
      meta: STATE_META.disconnected,
      params: { ...STATE_PARAMS.disconnected },
      live: toEngineLive(undefined),
      metrics: {},
      recentEvents: [],
      warnings: [],
      changedAt: now,
    };
  }

  const meta = STATE_META[session.state] ?? STATE_META.unknown;
  const simulated = session.source === 'simulated';
  const inferred = session.confidence !== 'confirmed';
  return {
    ...session,
    meta,
    simulated,
    inferred,
    confirmed: session.confidence === 'confirmed',
    params: { ...STATE_PARAMS[session.state] },
    live: toEngineLive(session),
    changedAt: now,
  };
}

/** Does this state count as "the agent is working" for the perf governor? */
export function isActiveState(state) {
  return ACTIVE_STATES.includes(state);
}

/** True for states where the 24fps idle cap is appropriate. */
export function isIdleLikeState(state) {
  return !isActiveState(state);
}

/**
 * Pick the session the HUD should foreground when the bridge does not name one:
 * the most urgent active session wins, then the most recently seen.
 */
export function pickPrimarySession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return undefined;
  const rank = (view) => (STATE_META[view.state] ?? STATE_META.unknown).severity;
  const sorted = sessions
    .slice()
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0);
    });
  return sorted[0];
}

/** Human labels for the source badge (native / inferred / simulated). */
export function sourceBadge(source) {
  const meta = SOURCE_META[source] ?? SOURCE_META.derived;
  return { ...meta, key: source in SOURCE_META ? source : 'derived' };
}

/** Human labels for the confidence badge. */
export function confidenceBadge(confidence) {
  const meta = CONFIDENCE_META[confidence] ?? CONFIDENCE_META.unverified;
  return { ...meta, key: confidence in CONFIDENCE_META ? confidence : 'unverified' };
}

/**
 * Turn a `hosts[].capabilities` object into HUD chips. Negative capabilities are
 * the useful ones: they explain why a panel says "—" instead of showing zeros.
 */
export function capabilityChips(capabilities) {
  if (!isObject(capabilities)) {
    return [{ key: 'unknown', label: '能力未声明', tone: 'muted' }];
  }
  const chips = [];
  if (capabilities.tokenMetrics === false) {
    chips.push({ key: 'tokenMetrics', label: '无 token 指标', tone: 'warn' });
  } else if (capabilities.tokenMetrics === true) {
    chips.push({ key: 'tokenMetrics', label: 'token 指标', tone: 'ok' });
  }
  if (capabilities.outputStream === false) {
    chips.push({ key: 'outputStream', label: '无输出流', tone: 'warn' });
  } else if (capabilities.outputStream === true) {
    chips.push({ key: 'outputStream', label: '输出流', tone: 'ok' });
  }
  if (capabilities.approval === true) chips.push({ key: 'approval', label: '支持审批', tone: 'ok' });
  if (capabilities.toolUse === false) chips.push({ key: 'toolUse', label: '无工具事件', tone: 'warn' });
  else if (capabilities.toolUse === true) chips.push({ key: 'toolUse', label: '工具事件', tone: 'ok' });
  if (capabilities.sessionStart === true) chips.push({ key: 'sessionStart', label: '会话事件', tone: 'ok' });
  if (chips.length === 0) chips.push({ key: 'declared', label: '能力已声明', tone: 'muted' });
  return chips.slice(0, 5);
}

/** Compact metric text for the HUD; `—` when the bridge did not supply a value. */
export function formatMetric(value, options = {}) {
  if (value === undefined || value === null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (options.percent && options.total > 0) {
    return `${Math.round(Math.min(1, Math.max(0, n / options.total)) * 100)}%`;
  }
  if (options.compact && n >= 1000) {
    return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(1)}k`;
  }
  return String(Math.round(n * 100) / 100);
}
