/**
 * HALOFLUX Universal Agent Visualizer — visual presets.
 *
 * Every preset is a *complete* engine parameter set (all ~109 engine keys plus
 * the visualizer-only `fpsCap`). That is what makes presets reversible: applying
 * `original` after `focus` restores every key, including the particle counts and
 * the composition offsets. There is no hidden "current preset delta" state.
 *
 * The engine defaults come from `upstream/dsh-haloflux` (BASE + BAKED_MINE, the
 * author's shipped MINE look). The only deliberate deviation is the companion
 * composition: the light ring sits right of centre so the floating HUD can live
 * on the left without fighting the light. This is a layout decision, not a new
 * visual language.
 *
 * License: PolyForm Noncommercial 1.0.0. See ../LICENSE and ../NOTICE.
 */
import { HalofluxEngine } from './engine.js';

const ENGINE_PARAMS = HalofluxEngine.PARAMS;
const ENGINE_BASE = HalofluxEngine.BASE;
const ENGINE_MINE = HalofluxEngine.PRESETS.MINE;

/** key -> { label, min, max, step, group, rebuild } */
export const PARAM_MAP = Object.freeze(
  ENGINE_PARAMS.reduce((map, row) => {
    map[row[0]] = Object.freeze({
      label: row[1],
      min: row[2],
      max: row[3],
      step: row[4],
      group: row[5],
      rebuild: row[6],
    });
    return map;
  }, Object.create(null)),
);

export const ENGINE_PARAM_KEYS = Object.freeze(Object.keys(PARAM_MAP));

/** Visualizer-only keys that never reach the Canvas engine. */
export const VISUAL_PARAM_KEYS = Object.freeze(['fpsCap']);

export const FPS_CAP = Object.freeze({ min: 24, max: 120, step: 6, default: 60, idle: 24 });

const COMMON = Object.freeze({
  // companion composition: ring right of centre, HUD lives on the left
  centerX: 1.02,
  centerY: 0,
  scale: 0.66,
  // transparent additive overlay: the dark UI surface is CSS, not canvas
  backdrop: 0,
  // no automatic push-in camera while the user is reading/working
  camera: 0,
  // the state layer always owns dataMode (2 real-only, 1 for simulated)
  dataMode: 2,
  hudOn: 0,
  // performance is governed by perf.js, not by the engine's internal probe
  adaptQuality: 0,
  // deterministic default state envelope
  attackMs: 800,
  releaseMs: 2600,
});

const ORIGINAL = Object.freeze({
  ...ENGINE_MINE,
  ...COMMON,
  opacity: 0.55,
  fpsCap: 60,
});

const MINIMAL = Object.freeze({
  ...ENGINE_MINE,
  ...COMMON,
  opacity: 0.28,
  fpsCap: 30,
  glow: 0.55,
  ringSpeed: 0.55,
  ringPause: 2.2,
  ringWidth: 1.12,
  rimBright: 0.9,
  runnerCount: 150,
  runnerBright: 0.34,
  runnerSpeed: 0.5,
  cometPerBeat: 0.3,
  cometBurst: 1,
  cometTrickle: 0,
  cometBright: 0.55,
  hazeCount: 2,
  hazeBright: 0.4,
  flyerCount: 0,
  burstRate: 0,
  flareRate: 0.5,
  beamBright: 0.5,
  beamLen: 0.8,
  beamGlow: 0.6,
  dashBright: 0.4,
  bokeh: 0,
  atmos: 0.3,
  scan: 0,
  ringData: 0.4,
  phaseRing: 1,
  errPin: 1,
  tpsRibbon: 1,
  stepTicks: 0,
});

const SCI_FI = Object.freeze({
  ...ENGINE_MINE,
  ...COMMON,
  opacity: 0.56,
  fpsCap: 60,
  glow: 1.35,
  ringWidth: 1.35,
  rimBright: 1.9,
  runnerCount: 760,
  runnerBright: 0.62,
  cometPerBeat: 2.8,
  cometBurst: 11,
  cometTrickle: 2,
  hazeCount: 18,
  hazeBright: 1.7,
  flyerCount: 3,
  burstRate: 4,
  flareRate: 4,
  beamBright: 2,
  beamGlow: 4.5,
  bokeh: 14,
  depthBlur: 2,
  depthDim: 0.7,
  scan: 1,
  phaseRing: 1,
  errFx: 1,
  errPin: 1,
  glitchAmt: 0.8,
  tpsRibbon: 1,
  ctxArc: 1,
});

const FOCUS = Object.freeze({
  ...ENGINE_MINE,
  ...COMMON,
  opacity: 0.24,
  fpsCap: 30,
  glow: 0.55,
  centerY: -0.02,
  scale: 0.6,
  motionQuiet: 0.75,
  ringSpeed: 0.5,
  ringPause: 1.8,
  runnerCount: 220,
  runnerBright: 0.32,
  cometPerBeat: 0.5,
  cometBurst: 2,
  hazeCount: 3,
  hazeBright: 0.5,
  bokeh: 0,
  scan: 0,
  guardOn: 1,
  guardStrength: 0.35,
  guardRadius: 0.85,
  ringData: 0.45,
  phaseRing: 1,
  tpsRibbon: 1,
  ctxArc: 1,
  errPin: 1,
  stepTicks: 0,
});

const AMBIENT = Object.freeze({
  ...ENGINE_MINE,
  ...COMMON,
  opacity: 0.16,
  fpsCap: 24,
  idleMotion: 0.1,
  runLevel: 0.55,
  glow: 0.5,
  tempo: 0.55,
  ringSpeed: 0.45,
  ringPause: 2.4,
  ringWidth: 1.1,
  runnerCount: 90,
  runnerBright: 0.28,
  runnerSpeed: 0.4,
  cometPerBeat: 0.2,
  cometBurst: 0,
  cometTrickle: 0,
  hazeCount: 2,
  hazeBright: 0.35,
  flyerCount: 0,
  burstRate: 0,
  flareRate: 0,
  beamBright: 0.35,
  beamGlow: 0.5,
  dashBright: 0.25,
  bokeh: 0,
  atmos: 0.35,
  scan: 0,
  phaseRing: 1,
  errPin: 1,
  tpsRibbon: 0,
  ctxArc: 0,
  stepTicks: 0,
});

const AGENT_MONITOR = Object.freeze({
  ...ENGINE_MINE,
  ...COMMON,
  // Paper Lab composition: recover the original off-left ring and strong
  // monochrome contrast. Companion/ambient presets keep their softer layout.
  centerX: 0,
  scale: 1,
  opacity: 0.83,
  fpsCap: 60,
  glow: 1.2,
  tempo: 1,
  ringSpeed: 0.9,
  webBright: 0.96,
  webPulseBase: 0.05,
  webPulseAmp: 0.45,
  runnerCount: 620,
  runnerBright: 0.68,
  cometPerBeat: 1.1,
  cometBurst: 5,
  cometTrickle: 0.8,
  cometBright: 0.92,
  hazeCount: 9,
  hazeBright: 0.98,
  flyerCount: 1,
  burstRate: 1.2,
  burstBright: 0.9,
  flareRate: 1.2,
  flareBright: 0.9,
  beamBright: 1.65,
  beamGlow: 2.5,
  bokeh: 0,
  scan: 0,
  guardOn: 0,
  phaseRing: 1,
  errPin: 1,
  errFx: 1,
  glitchAmt: 0.65,
  tpsRibbon: 1,
  ctxArc: 1,
  stepTicks: 1,
  toolBeam: 1,
  ringData: 0.85,
});

/**
 * Six presets, ordered as they appear in the UI.
 * Each value is a complete parameter set, frozen so accidental mutation in a
 * consumer cannot corrupt later `setPreset('original')` calls.
 */
export const PRESETS = Object.freeze({
  original: ORIGINAL,
  minimal: MINIMAL,
  'sci-fi': SCI_FI,
  focus: FOCUS,
  ambient: AMBIENT,
  'agent-monitor': AGENT_MONITOR,
});

export const PRESET_ORDER = Object.freeze(Object.keys(PRESETS));
export const DEFAULT_PRESET = 'agent-monitor';

export const PRESET_META = Object.freeze({
  original: Object.freeze({
    nameZh: '原作',
    nameEn: 'Original',
    descriptionZh: 'HALOFLUX 原作光场：完整光带、数据面板与环外光束。',
    descriptionEn: 'The original HALOFLUX light field: full ring, data panels and outer beams.',
    tone: 'warm',
  }),
  minimal: Object.freeze({
    nameZh: '极简',
    nameEn: 'Minimal',
    descriptionZh: '低干扰：细环、少粒子、无环境光斑，适合日常陪跑。',
    descriptionEn: 'Low distraction: thin ring, few particles, no bokeh — for everyday company.',
    tone: 'quiet',
  }),
  'sci-fi': Object.freeze({
    nameZh: '科幻光场',
    nameEn: 'Sci-Fi Field',
    descriptionZh: '完整光场：高密度光束、景深虚化与故障脉冲。',
    descriptionEn: 'Full light field: dense beams, depth blur and glitch accents.',
    tone: 'cool',
  }),
  focus: Object.freeze({
    nameZh: '专注',
    nameEn: 'Focus',
    descriptionZh: '长期编码友好：压低亮度、收敛环体、显著减弱运动。',
    descriptionEn: 'Built for long coding sessions: dimmer, tighter, slower motion.',
    tone: 'quiet',
  }),
  ambient: Object.freeze({
    nameZh: '环境',
    nameEn: 'Ambient',
    descriptionZh: '空闲低功耗：24fps 上限、稀薄呼吸光，不抢注意力。',
    descriptionEn: 'Idle low-power mode: 24fps cap and a faint breathing ring.',
    tone: 'quiet',
  }),
  'agent-monitor': Object.freeze({
    nameZh: 'Agent 监控',
    nameEn: 'Agent Monitor',
    descriptionZh: '突出真实 Agent 状态：相位环、工具光束、错误钉与上下文弧全部开启。',
    descriptionEn: 'Puts real agent state first: phase ring, tool beams, error pins and context arc on.',
    tone: 'cool',
  }),
});

/** True when `name` is one of the six shipped presets. */
export function isPresetName(name) {
  return Object.prototype.hasOwnProperty.call(PRESETS, name);
}

/** A fresh (mutable) copy of a preset, or the default preset for unknown names. */
export function getPreset(name) {
  return { ...(PRESETS[isPresetName(name) ? name : DEFAULT_PRESET]) };
}

/** Alias with a clearer name for consumers that resolve user input. */
export function resolvePreset(name) {
  return getPreset(name);
}

/**
 * Clamp one engine parameter to its declared range.
 * Returns `undefined` for unknown keys or non-finite input (callers keep the
 * previous value rather than writing NaN into the renderer).
 */
export function clampParamValue(key, value) {
  const meta = PARAM_MAP[key];
  if (!meta) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(meta.max, Math.max(meta.min, n));
}

/** Clamp / validate a visualizer-only parameter. */
export function clampVisualParam(key, value) {
  if (key === 'fpsCap') {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(FPS_CAP.max, Math.max(FPS_CAP.min, Math.round(n)));
  }
  return undefined;
}

/**
 * Merge a partial parameter patch onto a base set.
 * Unknown keys are ignored on purpose: a corrupt settings file or a stale UI
 * control must never inject arbitrary properties into the renderer.
 *
 * @param {Record<string, unknown>} partial
 * @param {Record<string, unknown>} [base]
 * @returns {Record<string, unknown>} a new object (base keys preserved)
 */
export function sanitizeParams(partial, base = {}) {
  const out = { ...base };
  if (!partial || typeof partial !== 'object') return out;
  for (const key of Object.keys(partial)) {
    const engineValue = clampParamValue(key, partial[key]);
    if (engineValue !== undefined) {
      out[key] = engineValue;
      continue;
    }
    const visualValue = clampVisualParam(key, partial[key]);
    if (visualValue !== undefined) out[key] = visualValue;
  }
  return out;
}

/** Keep only keys the engine understands (used when passing params to Canvas). */
export function engineParamsOnly(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const key of ENGINE_PARAM_KEYS) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/**
 * Curated controls for the companion parameter drawer. Five sliders, exactly
 * the levers the product promises: opacity, brightness, ring speed, particles,
 * frame-rate cap. Everything else stays available through presets / settings.
 */
export const CURATED_PARAMS = Object.freeze([
  Object.freeze({ key: 'opacity', kind: 'engine', labelZh: '不透明度', labelEn: 'Opacity', min: 0, max: 1, step: 0.01, format: 'percent' }),
  Object.freeze({ key: 'glow', kind: 'engine', labelZh: '亮度', labelEn: 'Brightness', min: 0, max: 1.5, step: 0.05, format: 'decimal' }),
  Object.freeze({ key: 'ringSpeed', kind: 'engine', labelZh: '环速', labelEn: 'Ring speed', min: 0, max: 3, step: 0.05, format: 'decimal' }),
  Object.freeze({ key: 'runnerCount', kind: 'engine', labelZh: '粒子', labelEn: 'Particles', min: 0, max: 900, step: 10, format: 'int' }),
  Object.freeze({ key: 'fpsCap', kind: 'visual', labelZh: '帧率上限', labelEn: 'FPS cap', min: FPS_CAP.min, max: FPS_CAP.max, step: FPS_CAP.step, format: 'fps' }),
]);

/**
 * Particle / beam param keys that the perf governor scales down. Kept in one
 * place so quality steps are testable and never drift between modules.
 */
export const QUALITY_SCALED_KEYS = Object.freeze([
  'runnerCount',
  'cometPerBeat',
  'cometBurst',
  'cometTrickle',
  'hazeCount',
  'bokeh',
  'flyerCount',
  'burstRate',
  'flareRate',
]);

export { ENGINE_BASE };
