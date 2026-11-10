/**
 * HALOFLUX Universal Agent Visualizer — visual core public API.
 *
 * Contract: docs/architecture.md §8. `createVisualizer({canvas, params,
 * reducedMotion})` returns:
 *
 *   start, stop, pause, resume,
 *   setSession, setSessions, setParams, getParams, setPreset,
 *   resize, onStats, setStateHook, destroy
 *
 * The Canvas light field comes from `engine.js` (the dsh-haloflux port). This
 * module is the adapter between the normalized SessionView and that engine:
 * it owns the perf governor, the preset/state parameter layering, truthfulness
 * rules (simulated watermark, no invented token metrics) and the post-frame
 * agent-state cues.
 *
 * License: PolyForm Noncommercial 1.0.0. See ../LICENSE and ../NOTICE.
 */
import { HalofluxEngine } from './engine.js';
import {
  PRESETS,
  PRESET_META,
  PRESET_ORDER,
  DEFAULT_PRESET,
  FPS_CAP,
  PARAM_MAP,
  QUALITY_SCALED_KEYS,
  CURATED_PARAMS,
  isPresetName,
  resolvePreset,
  sanitizeParams,
  engineParamsOnly,
} from './presets.js';
import {
  AGENT_STATES,
  ACTIVE_STATES,
  STATE_META,
  SOURCE_META,
  CONFIDENCE_META,
  normalizeSession,
  stateVisual,
  isActiveState,
  isIdleLikeState,
  pickPrimarySession,
  sourceBadge,
  confidenceBadge,
  capabilityChips,
  formatMetric,
} from './state-map.js';
import { createPerfGovernor, createViewportWatcher, clampDpr } from './perf.js';

export {
  PRESETS,
  PRESET_META,
  PRESET_ORDER,
  DEFAULT_PRESET,
  CURATED_PARAMS,
  STATE_META,
  SOURCE_META,
  CONFIDENCE_META,
  AGENT_STATES,
  normalizeSession,
  pickPrimarySession,
  sourceBadge,
  confidenceBadge,
  capabilityChips,
  formatMetric,
};

const nowMs = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const OVERLAY_FONT = '600 10px "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace';
const OVERLAY_FONT_SMALL = '500 9px "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace';
const OVERLAY_FONT_TINY = '600 8px "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace';

const HOST_CODE = Object.freeze({
  'deepseek-harness': 'DS',
  codex: 'CX',
  cursor: 'CU',
  workbuddy: 'WB',
  'claude-code': 'CC',
  trae: 'TR',
  generic: 'GN',
  simulator: 'SIM',
});

function hexToRgba(hex, alpha) {
  const value = String(hex || '#ffffff').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function reducedMotionFrom(options, win) {
  if (typeof options.reducedMotion === 'boolean') return options.reducedMotion;
  try {
    return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * Create one visualizer bound to one canvas.
 * Rendering starts only on `start()` so the renderer can lay out first.
 */
export function createVisualizer(options = {}) {
  const canvas = options.canvas;
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('createVisualizer: a canvas element with getContext() is required');
  }
  const doc = options.document !== undefined
    ? options.document
    : (typeof document !== 'undefined' ? document : null);
  const win = options.window !== undefined
    ? options.window
    : (typeof window !== 'undefined' ? window : null);
  const clock = typeof options.now === 'function' ? options.now : nowMs;

  let destroyed = false;
  let started = false;
  let presetName = isPresetName(options.preset) ? options.preset : DEFAULT_PRESET;
  let baseParams = resolvePreset(presetName);
  let userParams = {};
  let sizeOverride = null;

  let motionQuery = null;
  let reducedMotion = reducedMotionFrom(options, win);
  let instantTransitions = options.instantTransitions === true;
  /** The renderer draws its own DOM watermark; standalone embedders keep the
   *  canvas corner mark so a simulated source is never unlabelled. */
  const showSimulatedMark = options.showSimulatedMark !== false;
  let qualityFactorValue = 1;
  let qualityLevelValue = 0;

  const statsListeners = new Set();
  const stateListeners = new Set();

  let currentVisual = stateVisual(undefined, clock());
  let currentSessionView = undefined;
  let sessions = [];
  let extraOverlay = null;
  let previousState = currentVisual.state;
  let flareAt = -Infinity;
  let lastStats = {
    fps: 0,
    frameMs: 0,
    quality: 1,
    qualityLevel: 0,
    particles: 0,
    frames: 0,
    paused: false,
    running: false,
    state: currentVisual.state,
    preset: presetName,
    source: currentVisual.source,
    confidence: currentVisual.confidence,
    simulated: false,
    sessionId: '',
    sessions: 0,
    canvasWidth: 0,
    canvasHeight: 0,
  };

  const live = stateVisual(undefined, 0).live;

  let governor = null;

  /** Quality factor is owned by the governor, but the governor is created after
   *  the engine; before that the factor is 1. */
  function currentQualityFactor() {
    return governor ? governor.getQualityFactor() : qualityFactorValue;
  }

  /** Preset + state behaviour + user overrides, then truthfulness clamps. */
  function effectiveParams() {
    const merged = {
      ...baseParams,
      ...currentVisual.params,
      ...userParams,
    };
    // Truthfulness: a real session must never print the engine's synthetic
    // instrumentation numbers. Simulated demo data is allowed to look alive but
    // is watermarked in the DOM and on the canvas.
    merged.dataMode = currentVisual.simulated ? 1 : 2;
    // The governor owns quality; the engine's internal probe would double-step.
    merged.adaptQuality = 0;
    if (reducedMotion) {
      merged.camera = 0;
      merged.scan = 0;
    }
    const factor = currentQualityFactor();
    if (factor < 1) {
      for (const key of QUALITY_SCALED_KEYS) {
        const meta = PARAM_MAP[key];
        const value = Number(merged[key]);
        if (!meta || !Number.isFinite(value)) continue;
        merged[key] = Math.min(meta.max, Math.max(meta.min, value * factor));
      }
    }
    return merged;
  }

  function syncEngineParams() {
    if (destroyed) return;
    const params = effectiveParams();
    try {
      engine.setParams(engineParamsOnly(params));
    } catch {
      /* the engine clamps everything anyway; a bad param must not break the HUD */
    }
    // Upstream mount.js applied the layer opacity as CSS opacity; keep that
    // behaviour so the canvas can sit over the app background additively.
    if (canvas.style && typeof params.opacity === 'number') {
      try { canvas.style.opacity = String(clampNumber(params.opacity, 0, 1, 1)); } catch { /* ignore */ }
    }
    if (governor) {
      const cap = Number(params.fpsCap);
      if (Number.isFinite(cap)) governor.setTargetFps(cap);
      governor.setIdleFps(Math.min(Number.isFinite(cap) ? cap : FPS_CAP.default, FPS_CAP.idle));
    }
    lastStats = { ...lastStats, quality: currentQualityFactor(), qualityLevel: qualityLevelValue };
  }

  function syncLive() {
    const next = currentVisual.live || {};
    for (const key of Object.keys(live)) {
      if (!(key in next)) delete live[key];
    }
    Object.assign(live, next);
  }

  /** Stats + state payload shared by onStats / setStateHook / QA hooks. */
  function buildStats() {
    const base = governor ? governor.getStats() : {
      fps: 0, frameMs: 0, quality: qualityFactorValue, qualityLevel: qualityLevelValue,
      particles: 0, frames: 0, paused: false, running: false,
    };
    let geom = null;
    try { geom = engine.getGeometry(); } catch { geom = null; }
    const dpr = geom && geom.DPR ? geom.DPR : (sizeOverride ? clampDpr(win && win.devicePixelRatio) : 1);
    const cssWidth = geom && geom.W ? geom.W : (sizeOverride ? sizeOverride.w : 0);
    const cssHeight = geom && geom.H ? geom.H : (sizeOverride ? sizeOverride.h : 0);
    const stats = {
      ...base,
      state: currentVisual.state,
      preset: presetName,
      source: currentVisual.source,
      confidence: currentVisual.confidence,
      simulated: !!currentVisual.simulated,
      inferred: !!currentVisual.inferred,
      sessionId: currentVisual.sessionId || '',
      sessions: Math.max(sessions.length, currentVisual.sessionId ? 1 : 0),
      particlesByKind: geom && engine ? (() => {
        try { return engine.debug().particlesByKind || null; } catch { return null; }
      })() : null,
      canvasWidth: Math.round((cssWidth || 0) * (dpr || 1)),
      canvasHeight: Math.round((cssHeight || 0) * (dpr || 1)),
      cssWidth: Math.round(cssWidth || 0),
      cssHeight: Math.round(cssHeight || 0),
      reducedMotion,
    };
    lastStats = stats;
    return stats;
  }

  function emitStats() {
    if (destroyed) return;
    const stats = buildStats();
    for (const listener of Array.from(statsListeners)) {
      try { listener(stats); } catch { /* one HUD listener must not break the rest */ }
    }
  }

  function emitState() {
    if (destroyed) return;
    const stats = buildStats();
    for (const listener of Array.from(stateListeners)) {
      try { listener(stats); } catch { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ *
   * post-frame overlay: agent state cues
   * ------------------------------------------------------------------ */

  function strokeArc(ctx, cx, cy, radius, start, end, color, alpha, width, dash) {
    if (!(radius > 0) || alpha <= 0.002) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end);
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
    ctx.restore();
  }

  function drawFlare(ctx, info, geom) {
    if (!Number.isFinite(flareAt) || flareAt < 0) return;
    const elapsed = (Number(info.time) - flareAt) / 1000;
    if (!(elapsed >= 0) || elapsed > 0.9) return;
    const u = Math.min(1, elapsed / 0.9);
    strokeArc(
      ctx, geom.cx, geom.cy, geom.R * (0.9 + 0.16 * u),
      -Math.PI / 2, -Math.PI / 2 + Math.PI * 2,
      `rgba(226,236,255,${(1 - u) * 0.35})`, 1.4, 1.6,
    );
  }

  function drawStateCue(ctx, info, geom) {
    const { cx, cy, R, W, H } = geom;
    const t = Number(info.t) || 0;
    const color = (currentVisual.meta && currentVisual.meta.color) || '#8195ad';
    const inferred = !!currentVisual.inferred;
    const state = currentVisual.state;

    if (state === 'disconnected') {
      // Dim and static. No time term here: a disconnected session must not look
      // like it is "doing something".
      for (let i = 0; i < 3; i += 1) {
        const start = -Math.PI / 2 + i * (Math.PI * 2 / 3) + 0.16;
        strokeArc(ctx, cx, cy, R * 0.88, start, start + 1.02, hexToRgba(color, 1), 0.055, 1.2);
      }
      return;
    }

    if (state === 'connected' || state === 'idle') {
      const breath = 0.5 + 0.5 * Math.sin(t * (state === 'idle' ? 0.8 : 0.55));
      const alpha = 0.09 + 0.08 * breath;
      const rr = R + 26;
      strokeArc(ctx, cx, cy, rr, -Math.PI * 0.78, -Math.PI * 0.22, hexToRgba(color, 1), alpha, 1.3, inferred ? [3, 9] : null);
      if (state === 'connected') {
        strokeArc(ctx, cx, cy, rr, Math.PI * 0.72, Math.PI * 1.28, hexToRgba(color, 1), alpha * 0.7, 1.1);
      }
      return;
    }

    if (state === 'running') {
      const rotate = t * 0.5;
      strokeArc(ctx, cx, cy, R + 30, rotate, rotate + 0.8, hexToRgba(color, 1), inferred ? 0.12 : 0.18, 1.6, inferred ? [4, 7] : null);
      strokeArc(ctx, cx, cy, R + 30, rotate + Math.PI, rotate + Math.PI + 0.42, hexToRgba(color, 1), 0.11, 1.1);
      return;
    }

    if (state === 'tool') {
      // Outer beams + data blocks: the engine already draws a labelled tool beam
      // when a tool is active; these short radial ticks make the "busy" phase
      // readable even when the tool name is unavailable.
      for (let i = 0; i < 3; i += 1) {
        const angle = -0.7 + i * 2.1 + Math.sin(t * 0.4 + i) * 0.08;
        const r0 = R + 12;
        const r1 = R + 44 + Math.sin(t * 1.4 + i * 1.7) * 7;
        const alpha = 0.16 + 0.1 * (0.5 + 0.5 * Math.sin(t * 1.8 + i));
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = hexToRgba(color, alpha);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
        ctx.lineTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
        ctx.stroke();
        ctx.fillStyle = hexToRgba(color, alpha * 1.6);
        ctx.fillRect(cx + Math.cos(angle) * r1 - 2, cy + Math.sin(angle) * r1 - 2, 4, 4);
        ctx.restore();
      }
      return;
    }

    if (state === 'output') {
      const rotate = t * 0.75;
      ctx.save();
      ctx.strokeStyle = hexToRgba(color, inferred ? 0.16 : 0.24);
      ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 9]);
      ctx.lineDashOffset = -t * 28;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      strokeArc(ctx, cx, cy, R + 34, rotate, rotate + 0.62, hexToRgba(color, 1), 0.22, 2);
      return;
    }

    if (state === 'waiting_approval') {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.6);
      strokeArc(ctx, cx, cy, R + 26, 0, Math.PI * 2, hexToRgba(color, 1), 0.18 + 0.28 * pulse, 1.8);
      strokeArc(ctx, cx, cy, R + 42, -Math.PI / 2, Math.PI * 1.5, hexToRgba(color, 1), 0.1 + 0.16 * pulse, 1.1, [2, 10]);
      // three waiting blocks slowly orbiting: "the host is blocked on a human"
      for (let i = 0; i < 3; i += 1) {
        const angle = t * 0.22 + i * (Math.PI * 2 / 3);
        const rr = R + 34;
        const x = cx + Math.cos(angle) * rr;
        const y = cy + Math.sin(angle) * rr;
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.35 * pulse;
        ctx.fillStyle = hexToRgba(color, 1);
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.restore();
      }
      return;
    }

    if (state === 'done') {
      const elapsed = (Number(info.time) - currentVisual.changedAt) / 1000;
      if (!(elapsed >= 0) || elapsed > 2.4) return;
      const u = Math.min(1, elapsed / 1.3);
      strokeArc(ctx, cx, cy, R * (1.06 - 0.06 * u), -Math.PI / 2, Math.PI * 1.5, hexToRgba(color, 1), (1 - elapsed / 2.4) * 0.3, 1.8);
      return;
    }

    if (state === 'error') {
      // A pinned, localised fault: fixed angle derived from the session id, so
      // repeated errors stay in the same place instead of strobe-scanning.
      const raw = String(currentVisual.sessionId || 'error');
      let h = 2166136261;
      for (let i = 0; i < raw.length; i += 1) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const angle = ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
      const rr = R + 15;
      const x = cx + Math.cos(angle) * rr;
      const y = cy + Math.sin(angle) * rr;
      const jitter = Math.sin(t * 18) * 1.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,96,86,.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 5 + jitter, y - 5);
      ctx.lineTo(x + 5 + jitter, y + 5);
      ctx.moveTo(x + 5 + jitter, y - 5);
      ctx.lineTo(x - 5 + jitter, y + 5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(90,140,255,.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 6 - jitter, y - 4);
      ctx.lineTo(x + 4 - jitter, y + 6);
      ctx.stroke();
      // a small broken red cage around the pinned point makes the local fault
      // readable at a glance without washing the whole frame red.
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(211,118,111,.55)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, R + 24, angle - 0.24, angle + 0.24);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    if (state === 'unknown') {
      // Subdued dashed phase ring. It drifts slowly because "unknown" is a live
      // uncertainty, not a frozen state; the low contrast keeps it quiet.
      ctx.save();
      ctx.strokeStyle = hexToRgba(color, 0.3 + 0.06 * Math.sin(t * 0.7));
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 12]);
      ctx.lineDashOffset = -t * 7;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      strokeArc(ctx, cx, cy, R * 0.9, -Math.PI / 2 - 0.09, -Math.PI / 2 + 0.09, hexToRgba(color, 1), 0.42, 2.2);
      return;
    }
  }

  function drawSatellites(ctx, geom) {
    const others = sessions
      .filter((session) => session.sessionId !== currentVisual.sessionId)
      .slice(0, 5);
    if (others.length === 0) return;
    const x = Math.max(40, geom.W - 62);
    const step = 54;
    const centerY = Math.min(Math.max(geom.H / 2, 90), geom.H - 90);
    const startY = centerY - ((others.length - 1) * step) / 2;
    others.forEach((session, index) => {
      const meta = STATE_META[session.state] || STATE_META.unknown;
      const y = startY + index * step;
      const simulated = session.source === 'simulated';
      const inferred = session.confidence !== 'confirmed';
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = hexToRgba(meta.color, 0.8);
      ctx.lineWidth = 1.6;
      if (simulated || inferred) ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(x, y, 12, -Math.PI / 2, Math.PI * 0.95);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = hexToRgba(meta.color, 0.9);
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      if (HOST_CODE[session.host]) {
        ctx.font = OVERLAY_FONT_TINY;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(220,228,240,.42)';
        ctx.fillText(HOST_CODE[session.host], x - 19, y);
      }
      ctx.restore();
    });
  }

  function drawSimulatedMark(ctx, geom) {
    const text = '示例数据 · SIMULATED';
    ctx.save();
    ctx.font = OVERLAY_FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidth = typeof ctx.measureText === 'function' ? ctx.measureText(text).width : 128;
    const x = 22;
    // above the 38px status bar; the left column ends well above this on 900px
    const y = Math.max(16, geom.H - 58);
    ctx.strokeStyle = 'rgba(224,178,104,.24)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.strokeRect(x - 8, y - 10, textWidth + 16, 20);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(228,195,140,.56)';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  function drawOverlay(ctx, info) {
    if (destroyed || !ctx || !info || !info.geometry) return;
    const geom = info.geometry;
    if (!(geom.W > 0 && geom.H > 0)) return;
    try {
      drawFlare(ctx, info, geom);
      drawStateCue(ctx, info, geom);
      drawSatellites(ctx, geom);
      if (currentVisual.simulated && showSimulatedMark) drawSimulatedMark(ctx, geom);
      if (extraOverlay) extraOverlay(ctx, info);
    } catch {
      /* overlay decoration must never break the engine frame */
    }
  }

  /* ------------------------------------------------------------------ *
   * engine + governor
   * ------------------------------------------------------------------ */
  const engine = HalofluxEngine.create({
    canvas,
    params: engineParamsOnly(effectiveParams()),
    live,
    reducedMotion,
    dpr: options.dpr,
    getSize: () => sizeOverride,
    overlay: drawOverlay,
  });

  governor = createPerfGovernor({
    onFrame: (dt) => {
      if (!destroyed) engine.render(dt);
    },
    onStats: (stats) => {
      lastStats = {
        ...stats,
        state: currentVisual.state,
        preset: presetName,
        source: currentVisual.source,
        confidence: currentVisual.confidence,
        simulated: !!currentVisual.simulated,
        sessionId: currentVisual.sessionId || '',
        sessions: Math.max(sessions.length, currentVisual.sessionId ? 1 : 0),
      };
      emitStats();
    },
    onQuality: (level, factor) => {
      qualityLevelValue = level;
      qualityFactorValue = factor;
      syncEngineParams();
      emitState();
    },
    isIdle: () => isIdleLikeState(currentVisual.state),
    getParticles: () => {
      try { return engine.debug().particles || 0; } catch { return 0; }
    },
    targetFps: Number(baseParams.fpsCap) || FPS_CAP.default,
    idleFps: Math.min(Number(baseParams.fpsCap) || FPS_CAP.default, FPS_CAP.idle),
    reducedMotion,
    document: doc,
    now: options.now,
    raf: options.raf,
    caf: options.caf,
    watchdog: options.watchdog === true,
  });

  // The engine's initial params were computed before the governor existed; push
  // the final truthfulness/quality values now.
  syncEngineParams();

  const viewport = (win && options.autoResize !== false)
    ? createViewportWatcher({
      canvas,
      window: win,
      onChange: (size) => resize(size),
    })
    : null;

  /** Keep prefers-reduced-motion live even if the OS setting changes at runtime. */
  if (win && typeof win.matchMedia === 'function') {
    try {
      motionQuery = win.matchMedia('(prefers-reduced-motion: reduce)');
      const onMotionChange = (event) => {
        if (typeof options.reducedMotion === 'boolean') return;
        setReducedMotion(!!event.matches);
      };
      if (motionQuery && typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', onMotionChange);
        motionQuery.__halofluxHandler = onMotionChange;
      }
    } catch { motionQuery = null; }
  }

  function setReducedMotion(value) {
    if (destroyed) return;
    reducedMotion = !!value;
    if (governor) governor.setReducedMotion(reducedMotion);
    try { engine.setReducedMotion(reducedMotion); } catch { /* ignore */ }
    syncEngineParams();
    emitState();
  }

  /** Deterministic captures: skip page-load fade-in on each state change. */
  function setInstantTransitions(value) {
    instantTransitions = !!value;
    if (instantTransitions && !destroyed) {
      try { engine.prime(); engine.render(1 / 60); } catch { /* ignore */ }
    }
  }

  function resize(size) {
    if (destroyed) return;
    let nextSize = size;
    if (!nextSize || (!Number.isFinite(nextSize.width) && !Number.isFinite(nextSize.height))) {
      nextSize = viewport ? viewport.measure() : null;
    }
    if (nextSize && Number.isFinite(nextSize.width) && Number.isFinite(nextSize.height)
      && nextSize.width > 0 && nextSize.height > 0) {
      sizeOverride = { w: Number(nextSize.width), h: Number(nextSize.height) };
    }
    const dpr = (nextSize && Number.isFinite(nextSize.dpr))
      ? clampDpr(nextSize.dpr)
      : clampDpr((win && win.devicePixelRatio) || engine.getGeometry().DPR || 1);
    try {
      engine.setDpr(dpr);
      engine.resize();
    } catch {
      /* a detached canvas must not throw into the host */
    }
    emitState();
  }

  function setSession(view) {
    if (destroyed) return;
    const normalized = normalizeSession(view);
    const now = clock();
    const next = stateVisual(normalized, now);
    const switched = !!(normalized && currentVisual.sessionId && normalized.sessionId !== currentVisual.sessionId);
    const wasActive = isActiveState(previousState);
    const lastRecent = normalized && normalized.recentEvents.length
      ? normalized.recentEvents[normalized.recentEvents.length - 1]
      : null;
    const taskFlare = !!(lastRecent
      && lastRecent.eventType === 'task.received'
      && now - lastRecent.timestamp >= -1000
      && now - lastRecent.timestamp <= 1500);
    if (switched) {
      try { engine.revolve(1); engine.switchFx(); } catch { /* engine not ready yet */ }
    }
    if ((next.state === 'running' && !wasActive) || taskFlare) {
      flareAt = now;
    }
    next.changedAt = now;
    currentSessionView = normalized;
    currentVisual = next;
    previousState = next.state;
    syncLive();
    syncEngineParams();
    if (instantTransitions) {
      // deterministic capture / demo: show the new state immediately instead of
      // trusting a possibly throttled rAF clock to complete the envelope.
      try { engine.prime(); engine.render(1 / 60); } catch { /* engine not ready yet */ }
    }
    emitState();
  }

  function setSessions(list) {
    if (destroyed) return;
    sessions = (Array.isArray(list) ? list : [])
      .map((view) => normalizeSession(view))
      .filter(Boolean)
      .slice(0, 24);
    emitState();
  }

  function setParams(partial) {
    if (destroyed) return;
    if (!partial || typeof partial !== 'object') return;
    const patch = sanitizeParams(partial, {});
    if (Object.keys(patch).length === 0) return;
    userParams = { ...userParams, ...patch };
    syncEngineParams();
    emitState();
  }

  function getParams() {
    return {
      ...baseParams,
      ...currentVisual.params,
      ...userParams,
    };
  }

  function setPreset(name) {
    if (destroyed || !isPresetName(name)) return false;
    presetName = name;
    baseParams = resolvePreset(name);
    userParams = {};
    syncEngineParams();
    // A preset is a full authored snapshot: rebuild the particle populations so
    // switching back to a quieter preset cannot inherit the previous preset's
    // still-alive hazes/comets/flyers.
    try { engine.rebuild(); } catch { /* engine not ready yet */ }
    if (instantTransitions) {
      try { engine.prime(); engine.render(1 / 60); } catch { /* ignore */ }
    }
    emitState();
    return true;
  }

  function onStats(callback) {
    if (typeof callback !== 'function') return () => {};
    statsListeners.add(callback);
    try { callback(buildStats()); } catch { /* ignore */ }
    return () => statsListeners.delete(callback);
  }

  function setStateHook(callback) {
    if (typeof callback !== 'function') return () => {};
    stateListeners.add(callback);
    try { callback(buildStats()); } catch { /* ignore */ }
    return () => stateListeners.delete(callback);
  }

  function start() {
    if (destroyed) return false;
    if (!started) {
      started = true;
      const initial = viewport ? viewport.measure() : null;
      if (initial && initial.width > 0 && initial.height > 0) {
        sizeOverride = { w: initial.width, h: initial.height };
      }
      if (initial && initial.dpr) {
        try { engine.setDpr(initial.dpr); } catch { /* ignore */ }
      }
      try { engine.resize(); } catch { /* ignore */ }
      // A companion window should never open on a black frame: prime the level
      // envelope (a no-op when there is no session) and paint one settled frame.
      try { engine.prime(); engine.render(1 / 60); } catch { /* ignore */ }
    }
    governor.start();
    emitState();
    return true;
  }

  function stop() {
    if (destroyed) return;
    governor.stop();
    emitState();
  }

  function pause() {
    if (destroyed) return;
    governor.pause();
    emitState();
  }

  function resume() {
    if (destroyed) return;
    governor.resume();
    emitState();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try { governor.destroy(); } catch { /* ignore */ }
    try { engine.dispose(); } catch { /* ignore */ }
    if (viewport) {
      try { viewport.destroy(); } catch { /* ignore */ }
    }
    if (motionQuery) {
      try {
        if (motionQuery.__halofluxHandler && typeof motionQuery.removeEventListener === 'function') {
          motionQuery.removeEventListener('change', motionQuery.__halofluxHandler);
        }
      } catch { /* ignore */ }
    }
    motionQuery = null;
    statsListeners.clear();
    stateListeners.clear();
    sessions = [];
    currentSessionView = undefined;
    if (canvas.style) {
      try { canvas.style.opacity = ''; } catch { /* ignore */ }
    }
  }

  return {
    // contract §8
    start,
    stop,
    pause,
    resume,
    setSession,
    setSessions,
    setParams,
    getParams,
    setPreset,
    resize,
    onStats,
    setStateHook,
    destroy,
    // diagnostics / HUD convenience (also used by the renderer QA hook)
    getStats: () => buildStats(),
    getGeometry: () => engine.getGeometry(),
    setExtraOverlay: (fn) => { extraOverlay = typeof fn === 'function' ? fn : null; },
    getVisualState: () => ({
      ...currentVisual,
      session: currentSessionView,
      sessions,
      preset: presetName,
      reducedMotion,
      quality: currentQualityFactor(),
    }),
    getPresetParams: () => ({ ...baseParams }),
    setReducedMotion,
    setInstantTransitions,
    get isDestroyed() { return destroyed; },
    get isRunning() { return governor ? governor.isRunning() : false; },
  };
}

export { HalofluxEngine };
