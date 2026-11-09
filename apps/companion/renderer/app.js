/**
 * HALOFLUX Universal Agent Visualizer — companion renderer.
 *
 * Data paths (only one is active at a time):
 *   1. live  : GET /v1/stream (SSE) on the loopback event bridge, token-authed.
 *   2. demo  : local simulated snapshot stream (`mock-session.js`), always
 *              marked source=simulated, confidence=unverified and watermarked.
 *
 * Truthfulness rules enforced here:
 *   - simulated data never looks like a host-native session (source badge,
 *     watermark, per-event marker, agent row tag);
 *   - missing token/context metrics render as "—" (capability chips explain why);
 *   - event rows only show event type / tool name / time — never prompt text.
 *
 * No build step, native ES modules, no third-party assets. License:
 * PolyForm Noncommercial 1.0.0 — see About.
 */
import {
  createVisualizer,
  PRESETS,
  PRESET_ORDER,
  PRESET_META,
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
} from '../../../packages/visual-core/src/index.js';
import { createMockStream } from './mock-session.js';
import { projectMonitor } from './monitor-projection.mjs';
import { parseObsidianMetadata } from './obsidian-metadata.mjs';
import { eventRate, METRIC_REGISTRY, toolWaterfall, criticalPath } from '../../../packages/analytics/src/index.mjs';
import { sortEvents, sessionAt, frameIndexAt, replayDurationMs } from './replay-engine.mjs';

/* ------------------------------------------------------------------ *
 * environment / query
 * ------------------------------------------------------------------ */

const query = new URLSearchParams(window.location.search);
const config = (window.halofluxConfig && typeof window.halofluxConfig === 'object')
  ? window.halofluxConfig
  : {};

const DEMO = query.get('demo') === '1' || query.get('mock') === '1' || config.demo === true;
const QA = query.get('qa') === '1' || query.has('preset') || query.has('state');
const MULTI = query.get('multi') === '1';

const HOSTS = [
  { id: 'deepseek-harness', name: 'DeepSeek Harness', short: 'DS' },
  { id: 'codex', name: 'Codex', short: 'CX' },
  { id: 'cursor', name: 'Cursor', short: 'CU' },
  { id: 'workbuddy', name: 'WorkBuddy', short: 'WB' },
  { id: 'claude-code', name: 'Claude Code', short: 'CC' },
  { id: 'trae', name: 'TRAE', short: 'TR' },
];
const HOST_BY_ID = new Map(HOSTS.map((host) => [host.id, host]));

const PREFS_KEY = 'haloflux.renderer.prefs.v1';

const WARNING_LABELS = Object.freeze({
  'no-token-metrics': '该宿主不提供 token 指标',
  'no-native-output-events': '该宿主不上报原生输出事件',
  'no-tool-events': '该宿主不上报工具事件',
  'no-native-approval': '该宿主无原生审批事件',
});

function readPreferences() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writePreferences(prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / disk full: preferences are optional */
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Only loopback HTTP(S) bridges are allowed. No accidental egress. */
function normalizeBridgeUrl(raw) {
  try {
    const url = new URL(String(raw || 'http://127.0.0.1:17817'));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

const prefs = readPreferences();
const queryPreset = query.get('preset');
const initialPreset = (queryPreset && Object.prototype.hasOwnProperty.call(PRESETS, queryPreset))
  ? queryPreset
  : (typeof prefs.preset === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, prefs.preset)
    ? prefs.preset
    : 'agent-monitor');
const initialOverrides = (!queryPreset && prefs.overrides && typeof prefs.overrides === 'object')
  ? prefs.overrides
  : {};
const initialReducedMotion = query.get('motion') === 'reduce'
  ? true
  : query.get('motion') === 'full'
    ? false
    : (typeof prefs.reducedMotion === 'boolean' ? prefs.reducedMotion : prefersReducedMotion());

const BRIDGE_URL = normalizeBridgeUrl(query.get('bridge') || config.bridgeUrl || 'http://127.0.0.1:17817');
const TOKEN = String(query.get('token') || config.token || '').trim();
const REPLAY_SESSION = String(query.get('replay') || '').trim();
const REPLAY_AT = Number(query.get('at'));
const TRACE_OPEN = query.get('trace') === '1';
const QUERY_STATE = query.get('state');
const PINNED_STATE = (QUERY_STATE && STATE_META[QUERY_STATE]) ? QUERY_STATE : null;
/** Electron shell mode: window | overlay | compact. Overlay keeps the normal
 *  HUD; compact swaps to a 320×320 mini layout. */
const CONFIG_MODE = String(query.get('mode') || config.mode || 'window').toLowerCase();
let appMode = ['window', 'overlay', 'compact'].includes(CONFIG_MODE) ? CONFIG_MODE : 'window';

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const els = {
  canvas: $('haloflux-canvas'),
  presetSwitch: $('preset-switch'),
  drawerPresets: $('drawer-presets'),
  agentList: $('agent-list'),
  agentCount: $('agent-count'),
  sessionSwitch: $('session-switch'),
  sessionCount: $('session-count'),
  stateBadge: $('state-badge'),
  stateLabel: $('state-label'),
  sourceBadge: $('source-badge'),
  confidenceBadge: $('confidence-badge'),
  sessionId: $('session-id'),
  sessionAffinity: $('session-affinity'),
  mModel: $('m-model'),
  mTps: $('m-tps'),
  mCtx: $('m-ctx'),
  mStep: $('m-step'),
  mTool: $('m-tool'),
  mTurn: $('m-turn'),
  capChips: $('cap-chips'),
  sessionWarnings: $('session-warnings'),
  eventList: $('event-list'),
  eventEmpty: $('event-empty'),
  eventCount: $('event-count'),
  labHeadCount: $('lab-head-count'),
  labFeedStatus: $('lab-feed-status'),
  labFeedRows: $('lab-feed-rows'),
  labTracePlot: $('lab-trace-plot'),
  labToolSummary: $('lab-tool-summary'),
  labWorkspaceDetails: $('lab-workspace-details'),
  labSourceDetails: $('lab-source-details'),
  labValidationDetails: $('lab-validation-details'),
  labTypeDetails: $('lab-type-details'),
  labHosts: $('lab-hosts'),
  labKnowledgeDetails: $('lab-knowledge-details'),
  labObsidianFile: $('lab-obsidian-file'),
  labMasthead: $('lab-masthead'),
  labKpiHosts: $('lab-kpi-hosts'),
  labKpiSessions: $('lab-kpi-sessions'),
  labKpiEvents: $('lab-kpi-events'),
  labKpiTools: $('lab-kpi-tools'),
  labKpiErrors: $('lab-kpi-errors'),
  labRateCanvas: $('lab-rate-canvas'),
  labRateWindow: $('lab-rate-window'),
  labFailCanvas: $('lab-fail-canvas'),
  labMatrixCanvas: $('lab-matrix-canvas'),
  labFeedFilter: $('lab-feed-filter'),
  labFeedPause: $('lab-feed-pause'),
  labFeedDetail: $('lab-feed-detail'),
  labEvidence: $('lab-evidence'),
  labEvidenceTitle: $('lab-evidence-title'),
  labEvidenceBody: $('lab-evidence-body'),
  labEvidenceClose: $('lab-evidence-close'),
  replayBar: $('replay-bar'),
  replaySession: $('replay-session'),
  replayClock: $('replay-clock'),
  replayPlay: $('replay-play'),
  replayStep: $('replay-step'),
  replaySpeed: $('replay-speed'),
  replayClose: $('replay-close'),
  tracePanel: $('trace-panel'),
  traceBody: $('trace-body'),
  traceClose: $('trace-close'),
  traceWaterfallTab: $('trace-tab-waterfall'),
  traceDagTab: $('trace-tab-dag'),
  traceCriticalTab: $('trace-tab-critical'),
  btnTrace: $('btn-trace'),
  feedMode: $('feed-mode'),
  linkStatus: $('link-status'),
  linkText: $('link-text'),
  watermark: $('watermark'),
  perfFps: $('perf-fps'),
  perfFrame: $('perf-frame'),
  perfQuality: $('perf-quality'),
  perfParticles: $('perf-particles'),
  btnPause: $('btn-pause'),
  pauseLabel: $('pause-label'),
  statusVersion: $('status-version'),
  paramRows: $('param-rows'),
  toggleMotion: $('toggle-motion'),
  toggleMotionSettings: $('toggle-motion-settings'),
  togglePause: $('toggle-pause'),
  paramsDrawer: $('params-drawer'),
  settingsDrawer: $('settings-drawer'),
  drawerBackdrop: $('drawer-backdrop'),
  aboutModal: $('about-modal'),
  aboutBackdrop: $('about-backdrop'),
  settingsMode: $('settings-mode'),
  settingsBridge: $('settings-bridge'),
  settingsToken: $('settings-token'),
  settingsTransport: $('settings-transport'),
  settingsSnapshot: $('settings-snapshot'),
  settingsReason: $('settings-reason'),
  btnParams: $('btn-params'),
  btnSettings: $('btn-settings'),
  btnAbout: $('btn-about'),
  btnReconnect: $('btn-reconnect'),
  btnEnterMock: $('btn-enter-mock'),
  btnResetLocal: $('btn-reset-local'),
  toast: $('toast'),
  qaStateControls: $('qa-state-controls'),
  compactHud: $('compact-hud'),
  compactState: $('compact-state'),
  compactStateLabel: $('compact-state-label'),
  compactAgent: $('compact-agent'),
  compactSource: $('compact-source'),
  compactFps: $('compact-fps'),
  compactParams: $('compact-params'),
  compactSettings: $('compact-settings'),
  compactAbout: $('compact-about'),
};

/* ------------------------------------------------------------------ *
 * app state
 * ------------------------------------------------------------------ */

const state = {
  mode: 'connecting',            // connecting | live | offline | simulated
  reason: '',
  snapshot: null,
  hosts: new Map(),
  sessions: [],
  selectedSessionId: null,
  selectedHost: null,
  manualSelection: false,
  preferredSessionId: query.get('session') || null,
  events: [],
  preset: initialPreset,
  overrides: { ...initialOverrides },
  uiValues: { ...PRESETS[initialPreset], ...initialOverrides },
  reducedMotion: initialReducedMotion,
  paused: false,
  stats: null,
  lastSnapshotAt: 0,
  gotSnapshot: false,
  mock: null,
  eventSource: null,
  connectTimer: null,
  qaSessions: false,
  obsidianMetadata: null, // user-selected in-memory aggregate, never persisted or uploaded
  feedPaused: false,
  feedFilter: 'all',
  feedSelectedKey: null,
  replay: null,
};

let saveTimer = null;
let toastTimer = null;

const viz = createVisualizer({
  canvas: els.canvas,
  preset: initialPreset,
  reducedMotion: initialReducedMotion,
  // Demo/QA captures run on a possibly throttled offscreen clock; do not make
  // the ring wait for an envelope that may only get one frame per second.
  instantTransitions: DEMO || QA,
  // The renderer has a DOM watermark; a second canvas label would be noise.
  showSimulatedMark: false,
  // Hidden Electron windows can throttle rAF to ~1 Hz even with
  // backgroundThrottling:false. The watchdog only fires when rAF stalls.
  watchdog: true,
});
viz.start();
if (Object.keys(initialOverrides).length > 0) {
  viz.setParams(initialOverrides);
}
state.stats = viz.getStats();

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatClock(timestamp) {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return '--:--:--';
  const date = new Date(ms);
  const pad = (value) => (value < 10 ? `0${value}` : String(value));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatParamValue(meta, value) {
  if (!Number.isFinite(Number(value))) return '—';
  if (meta.format === 'percent') return `${Math.round(Number(value) * 100)}%`;
  if (meta.format === 'fps') return `${Math.round(Number(value))} fps`;
  if (meta.format === 'int') return String(Math.round(Number(value)));
  const fixed = Number(value).toFixed(2);
  return fixed.replace(/\.?0+$/, '') || '0';
}

function contextText(metrics) {
  const used = Number(metrics.contextUsed);
  const limit = Number(metrics.contextLimit);
  if (Number.isFinite(used) && used > 0) {
    const usedText = formatMetric(used, { compact: true });
    if (Number.isFinite(limit) && limit > 0) {
      return `${usedText} · ${formatMetric(used, { percent: true, total: limit })}`;
    }
    return usedText;
  }
  return '—';
}

function selectedSession() {
  if (!state.selectedSessionId) return null;
  return state.sessions.find((session) => session.sessionId === state.selectedSessionId) || null;
}

function hostFor(hostId) {
  return state.hosts.get(hostId) || null;
}

function sessionsForHost(hostId) {
  return state.sessions.filter((session) => session.host === hostId);
}

function bestSessionForHost(hostId) {
  return pickPrimarySession(sessionsForHost(hostId)) || null;
}

function persistPreferences() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writePreferences({
    preset: state.preset,
    overrides: state.overrides,
    reducedMotion: state.reducedMotion,
  });
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writePreferences({
      preset: state.preset,
      overrides: state.overrides,
      reducedMotion: state.reducedMotion,
    });
  }, 250);
}

function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
    toastTimer = null;
  }, 2400);
}

/* ------------------------------------------------------------------ *
 * presets
 * ------------------------------------------------------------------ */

function applyPreset(name, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) return false;
  const { persist = true, silent = false } = options;
  state.preset = name;
  state.overrides = {};
  state.uiValues = { ...PRESETS[name] };
  viz.setPreset(name);
  document.body.dataset.preset = name;
  syncPresetButtons();
  syncParamControls();
  renderLabMonitor();
  if (persist) persistPreferences();
  if (!silent) toast(`预设 · ${PRESET_META[name].nameZh} / ${PRESET_META[name].nameEn}`);
  return true;
}

function buildPresetButtons() {
  clearNode(els.presetSwitch);
  clearNode(els.drawerPresets);
  for (const name of PRESET_ORDER) {
    const meta = PRESET_META[name];
    const button = make('button', 'preset-btn', meta.nameZh);
    button.type = 'button';
    button.dataset.preset = name;
    button.title = `${meta.nameEn} — ${meta.descriptionZh}`;
    button.setAttribute('aria-pressed', String(name === state.preset));
    els.presetSwitch.appendChild(button);

    const drawerButton = make('button', 'drawer-preset');
    drawerButton.type = 'button';
    drawerButton.dataset.preset = name;
    drawerButton.setAttribute('aria-pressed', String(name === state.preset));
    const strong = make('strong', '', `${meta.nameZh} · ${meta.nameEn}`);
    const description = make('span', '', meta.descriptionZh);
    drawerButton.append(strong, description);
    els.drawerPresets.appendChild(drawerButton);
  }
  els.presetSwitch.addEventListener('click', onPresetClick);
  els.drawerPresets.addEventListener('click', onPresetClick);
}

function onPresetClick(event) {
  const button = event.target.closest('[data-preset]');
  if (!button) return;
  applyPreset(button.dataset.preset);
}

function syncPresetButtons() {
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === state.preset));
  }
}

/* ------------------------------------------------------------------ *
 * parameter drawer
 * ------------------------------------------------------------------ */

function buildParamRows() {
  clearNode(els.paramRows);
  for (const meta of CURATED_PARAMS) {
    const row = make('label', 'param-row');
    row.dataset.param = meta.key;
    const label = make('span', 'param-label', meta.labelZh);
    const output = make('output', 'param-value');
    output.id = `out-${meta.key}`;
    const input = make('input');
    input.type = 'range';
    input.id = `slider-${meta.key}`;
    input.min = String(meta.min);
    input.max = String(meta.max);
    input.step = String(meta.step);
    input.setAttribute('aria-label', meta.labelZh);
    input.addEventListener('input', () => {
      setUserParam(meta.key, input.value);
    });
    row.append(label, output, input);
    els.paramRows.appendChild(row);
    syncParamControl(meta.key);
  }
}

function setUserParam(key, rawValue) {
  const meta = CURATED_PARAMS.find((entry) => entry.key === key);
  if (!meta) return;
  let value = Number(rawValue);
  if (!Number.isFinite(value)) return;
  value = Math.min(meta.max, Math.max(meta.min, value));
  if (meta.kind === 'visual') value = Math.round(value);
  state.overrides[key] = value;
  state.uiValues[key] = value;
  viz.setParams({ [key]: value });
  syncParamControl(key);
  schedulePersist();
}

function syncParamControl(key) {
  const meta = CURATED_PARAMS.find((entry) => entry.key === key);
  if (!meta) return;
  const row = els.paramRows ? els.paramRows.querySelector(`.param-row[data-param="${key}"]`) : null;
  if (!row) return;
  const input = row.querySelector('input');
  const output = row.querySelector('output');
  const raw = state.uiValues[key];
  const value = Number.isFinite(Number(raw)) ? Number(raw) : meta.min;
  if (input) {
    input.value = String(value);
    const ratio = meta.max === meta.min ? 0 : (value - meta.min) / (meta.max - meta.min);
    input.style.setProperty('--fill', `${Math.min(100, Math.max(0, ratio * 100))}%`);
  }
  if (output) output.textContent = formatParamValue(meta, value);
}

function syncParamControls() {
  for (const meta of CURATED_PARAMS) syncParamControl(meta.key);
}

/* ------------------------------------------------------------------ *
 * toggles
 * ------------------------------------------------------------------ */

function syncMotionControls() {
  for (const button of [els.toggleMotion, els.toggleMotionSettings]) {
    if (button) button.setAttribute('aria-checked', String(state.reducedMotion));
  }
}

function setReducedMotion(value, persist = true) {
  state.reducedMotion = !!value;
  viz.setReducedMotion(state.reducedMotion);
  syncMotionControls();
  if (persist) persistPreferences();
}

function syncPauseControls() {
  for (const button of [els.togglePause, els.btnPause]) {
    if (button) button.setAttribute('aria-pressed', String(state.paused));
  }
  if (els.pauseLabel) els.pauseLabel.textContent = state.paused ? '继续渲染' : '暂停渲染';
  if (els.btnPause) {
    const use = els.btnPause.querySelector('use');
    if (use) use.setAttribute('href', state.paused ? '#i-play' : '#i-pause');
  }
  if (els.togglePause) els.togglePause.setAttribute('aria-checked', String(state.paused));
}

function setPaused(paused) {
  state.paused = !!paused;
  if (state.paused) viz.pause();
  else viz.resume();
  syncPauseControls();
}

/* ------------------------------------------------------------------ *
 * panels / drawers
 * ------------------------------------------------------------------ */

function closeDrawers() {
  for (const drawer of [els.paramsDrawer, els.settingsDrawer]) {
    if (drawer) {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
    }
  }
  if (els.drawerBackdrop) els.drawerBackdrop.hidden = true;
}

function openDrawer(drawer) {
  if (!drawer) return;
  closeDrawers();
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  if (els.drawerBackdrop) els.drawerBackdrop.hidden = false;
}

function closeAbout() {
  if (els.aboutModal) {
    els.aboutModal.classList.remove('is-open');
    els.aboutModal.setAttribute('aria-hidden', 'true');
  }
  if (els.aboutBackdrop) els.aboutBackdrop.hidden = true;
}

function openAbout() {
  if (els.aboutModal) {
    els.aboutModal.classList.add('is-open');
    els.aboutModal.setAttribute('aria-hidden', 'false');
  }
  if (els.aboutBackdrop) els.aboutBackdrop.hidden = false;
}

function closeAllOverlays() {
  closeDrawers();
  closeAbout();
}

/* ------------------------------------------------------------------ *
 * render: agents, sessions, current session, events, mode
 * ------------------------------------------------------------------ */

function renderAgents() {
  clearNode(els.agentList);
  let withSessions = 0;
  for (const host of HOSTS) {
    const entry = hostFor(host.id);
    const sessions = sessionsForHost(host.id);
    const session = (healthiestSession(sessions) || null);
    if (session) withSessions += 1;
    const stateName = session ? session.state : 'disconnected';
    const meta = STATE_META[stateName] || STATE_META.disconnected;
    const selected = (selectedSession() && selectedSession().host === host.id)
      || (!selectedSession() && state.selectedHost === host.id);

    const row = make('li', 'agent-row');
    row.dataset.host = host.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(selected));
    if (session) row.classList.add('has-session');
    row.style.setProperty('--state-color', meta.color);

    const mark = make('span', 'agent-mark', host.short);
    const main = make('div', 'agent-main');
    const name = make('span', 'agent-name', host.name);
    const metaLine = make('span', 'agent-meta');
    const version = entry && entry.hostVersion ? `v${String(entry.hostVersion).replace(/^v/, '')}` : '—';
    metaLine.append(make('span', '', version));
    if (session) {
      metaLine.append(make('span', '', '·'));
      const source = make('span', 'agent-source', SOURCE_META[session.source] ? SOURCE_META[session.source].short : session.source);
      source.dataset.source = session.source;
      metaLine.append(source);
    } else {
      metaLine.append(make('span', '', '·'));
      metaLine.append(make('span', '', entry && entry.connected ? '无活动会话' : '未连接'));
    }
    main.append(name, metaLine);

    const stateLabel = make('span', 'agent-state', session ? meta.short : '无会话');
    row.append(mark, main, stateLabel);

    row.addEventListener('click', () => selectHost(host.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectHost(host.id);
      }
    });
    els.agentList.appendChild(row);
  }
  if (els.agentCount) els.agentCount.textContent = `${withSessions}/${HOSTS.length}`;
}

function healthiestSession(sessions) {
  if (!sessions || sessions.length === 0) return null;
  return pickPrimarySession(sessions);
}

function renderSessions() {
  clearNode(els.sessionSwitch);
  if (els.sessionCount) els.sessionCount.textContent = String(state.sessions.length);
  if (state.sessions.length === 0) {
    els.sessionSwitch.appendChild(make('span', 'session-chip-empty', '暂无活动会话'));
    return;
  }
  const sorted = state.sessions.slice().sort((a, b) => {
    const bySeverity = (STATE_META[a.state] || STATE_META.unknown).severity - (STATE_META[b.state] || STATE_META.unknown).severity;
    if (bySeverity !== 0) return bySeverity;
    return (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0);
  });
  for (const session of sorted) {
    const meta = STATE_META[session.state] || STATE_META.unknown;
    const chip = make('button', 'session-chip', `${HOST_BY_ID.get(session.host)?.short || session.host} · ${meta.short}`);
    chip.type = 'button';
    chip.dataset.session = session.sessionId;
    chip.title = `${session.host} · ${session.sessionId}`;
    chip.style.setProperty('--state-color', meta.color);
    chip.setAttribute('aria-pressed', String(session.sessionId === state.selectedSessionId));
    chip.addEventListener('click', () => selectSession(session.sessionId));
    els.sessionSwitch.appendChild(chip);
  }
}

function renderSession() {
  const session = selectedSession();
  if (!session) {
    if (els.stateBadge) els.stateBadge.style.setProperty('--state-color', STATE_META.disconnected.color);
    if (els.stateLabel) els.stateLabel.textContent = '无会话';
    if (els.sourceBadge) {
      els.sourceBadge.textContent = '—';
      els.sourceBadge.removeAttribute('data-source');
    }
    if (els.confidenceBadge) {
      els.confidenceBadge.textContent = '—';
      els.confidenceBadge.removeAttribute('data-confidence');
    }
    if (els.sessionId) {
      els.sessionId.textContent = '—';
      els.sessionId.removeAttribute('title');
    }
    if (els.sessionAffinity) {
      els.sessionAffinity.textContent = state.mode === 'simulated'
        ? '模拟流'
        : state.mode === 'connecting' ? '等待事件桥' : '—';
    }
    for (const key of ['mModel', 'mTps', 'mCtx', 'mStep', 'mTool', 'mTurn']) {
      if (els[key]) els[key].textContent = '—';
    }
    if (els.capChips) {
      clearNode(els.capChips);
      const chip = make('span', 'chip', state.mode === 'simulated' ? '模拟流 · 等待选择会话' : '等待事件桥');
      chip.dataset.tone = 'muted';
      els.capChips.appendChild(chip);
    }
    if (els.sessionWarnings) els.sessionWarnings.textContent = '';
    document.title = 'HALOFLUX — Universal Agent Visualizer';
    return;
  }

  const meta = STATE_META[session.state] || STATE_META.unknown;
  if (els.stateBadge) els.stateBadge.style.setProperty('--state-color', meta.color);
  if (els.stateLabel) els.stateLabel.textContent = `${meta.labelZh} · ${meta.labelEn}`;
  if (els.sessionId) {
    els.sessionId.textContent = `${session.host} · ${session.sessionId}`;
    els.sessionId.title = `${session.host} / ${session.sessionId}`;
  }
  if (els.sessionAffinity) {
    els.sessionAffinity.textContent = session.hostVersion ? `v${String(session.hostVersion).replace(/^v/, '')}` : '—';
  }

  const source = sourceBadge(session.source);
  if (els.sourceBadge) {
    els.sourceBadge.dataset.source = source.key;
    els.sourceBadge.textContent = `${source.labelZh} · ${source.labelEn}`;
    els.sourceBadge.title = source.descriptionZh;
  }
  const confidence = confidenceBadge(session.confidence);
  if (els.confidenceBadge) {
    els.confidenceBadge.dataset.confidence = confidence.key;
    els.confidenceBadge.textContent = `${confidence.labelZh} · ${confidence.labelEn}`;
  }

  const metrics = session.metrics || {};
  if (els.mModel) els.mModel.textContent = metrics.model || '—';
  if (els.mTps) els.mTps.textContent = formatMetric(metrics.tokensPerSecond);
  if (els.mCtx) els.mCtx.textContent = contextText(metrics);
  if (els.mStep) els.mStep.textContent = formatMetric(metrics.step);
  if (els.mTool) els.mTool.textContent = metrics.toolName || '—';
  if (els.mTurn) els.mTurn.textContent = formatMetric(metrics.turn);

  if (els.capChips) {
    clearNode(els.capChips);
    if (session.source === 'simulated') {
      const sim = make('span', 'chip', '模拟数据');
      sim.dataset.tone = 'warn';
      els.capChips.appendChild(sim);
    }
    const entry = hostFor(session.host);
    const chips = capabilityChips(entry ? entry.capabilities : null);
    for (const info of chips) {
      const chip = make('span', 'chip', info.label);
      chip.dataset.tone = info.tone;
      els.capChips.appendChild(chip);
    }
  }

  if (els.sessionWarnings) {
    const warnings = (session.warnings || []).map((warning) => WARNING_LABELS[warning] || warning);
    els.sessionWarnings.textContent = warnings.length > 0 ? `警告 · ${warnings.join('；')}` : '';
  }

  document.title = `HALOFLUX — ${meta.labelZh} · ${HOST_BY_ID.get(session.host)?.name || session.host}`;
}

function renderEvents() {
  if (!els.eventList) return;
  clearNode(els.eventList);
  const events = state.events.slice(-30).reverse();
  for (const event of events) {
    const row = make('li', 'event-row');
    row.dataset.sim = event.source === 'simulated' || state.mode === 'simulated' ? '1' : '0';
    const time = make('span', 'event-time', formatClock(event.timestamp));
    const type = make('span', 'event-type', event.eventType);
    const tool = make('span', 'event-tool', event.toolName || '');
    row.append(time, type, tool);
    els.eventList.appendChild(row);
  }
  if (els.eventEmpty) els.eventEmpty.hidden = events.length > 0;
  if (els.eventCount) els.eventCount.textContent = String(events.length);
}

/** Event detail: allowlisted fields only, rendered as text (never innerHTML). */
function renderFeedDetail(event) {
  if (!els.labFeedDetail) return;
  if (!event) {
    els.labFeedDetail.textContent = 'SELECT AN EVENT FOR ALLOWLISTED FIELDS';
    return;
  }
  const parts = [
    event.kind,
    `HOST ${event.host || '—'}`,
    `SRC ${event.source}`,
    `CONF ${event.confidence}`,
    `SESSION ${(event.sessionId || '—').slice(0, 10)}`,
    `TOOL ${event.tool || '—'}`,
    `CALL ${event.toolCallId || '—'}`,
    `DUR ${event.durationMs == null ? '—' : `${event.durationMs} ms`}`,
    `ERR ${event.errorCode || '—'}`,
  ];
  els.labFeedDetail.textContent = parts.join(' · ');
}

function canvasContext(canvas) {
  if (!canvas) return null;
  const width = Math.max(40, Math.round(canvas.clientWidth || 240));
  const height = Math.max(16, Math.round(canvas.clientHeight || 44));
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '8px "Cascadia Code", Consolas, monospace';
  ctx.textBaseline = 'top';
  return { ctx, width, height };
}

/** Tool event arrival rate over the last 120 s, bucketed by the analytics engine. */
let lastRate = null;
let lastFailureCount = 0;
let traceTab = 'waterfall';
function drawRateCanvas(events) {
  const surface = canvasContext(els.labRateCanvas);
  if (!surface) return;
  const { ctx, width, height } = surface;
  const toolOnly = events.filter((event) => typeof event.eventType === 'string' && event.eventType.startsWith('tool.'));
  const rate = eventRate(toolOnly, { now: Date.now(), windowMs: 120_000, buckets: 12, cacheLimit: 30 });
  lastRate = rate;
  ctx.strokeStyle = '#3f3f49';
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();
  if (rate.count === 0) {
    ctx.fillStyle = '#7d7d8a';
    ctx.fillText('NO TOOL EVENTS IN 120 S WINDOW', 2, Math.max(2, height / 2 - 4));
    els.labRateWindow.textContent = 'RATE 120s · 10s BUCKET · 0 CACHED (NOT TOTAL)';
    return;
  }
  const max = Math.max(1, ...rate.buckets);
  const stepX = width / rate.buckets.length;
  ctx.strokeStyle = '#d7d7df';
  ctx.lineWidth = 1;
  ctx.beginPath();
  rate.buckets.forEach((count, index) => {
    const x = stepX * index + stepX / 2;
    const y = height - 3 - (count / max) * (height - 8);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#8f8f9d';
  ctx.fillText(`${rate.count} CACHED`, width - 56, 1);
  els.labRateWindow.textContent = `RATE 120s · 10s BUCKET · ${rate.count} CACHED (NOT TOTAL) · λ=${rate.lambdaPerSecond.toFixed(3)}/s`;
}

/** Real failures/errors only; absence is explicitly not a pass. */
function drawFailureCanvas(events) {
  const surface = canvasContext(els.labFailCanvas);
  if (!surface) return;
  const { ctx, width, height } = surface;
  const now = Date.now();
  const windowMs = 120_000;
  const failures = events.filter((event) => typeof event.eventType === 'string'
    && (event.eventType === 'error' || event.eventType === 'tool.fail')
    && typeof event.timestamp === 'number'
    && event.timestamp >= now - windowMs);
  ctx.strokeStyle = '#3f3f49';
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();
  if (failures.length === 0) {
    lastFailureCount = 0;
    ctx.fillStyle = '#7d7d8a';
    ctx.fillText('NO FAILURE EVENTS IN 120 S (NOT A PASS)', 2, Math.max(2, height / 2 - 4));
    return;
  }
  lastFailureCount = failures.length;
  for (const event of failures) {
    const ratio = Math.max(0, Math.min(1, (now - event.timestamp) / windowMs));
    const x = width - ratio * width;
    ctx.fillStyle = '#c98383';
    ctx.fillRect(Math.max(0, Math.min(width - 1, x)), 2, 1, height - 4);
  }
  ctx.fillStyle = '#9b9ba8';
  ctx.fillText(`${failures.length} CACHED`, width - 48, 1);
}

/** Host x state matrix from real sessions (no synthetic population). */
function drawMatrixCanvas() {
  const surface = canvasContext(els.labMatrixCanvas);
  if (!surface) return;
  const { ctx, width, height } = surface;
  const states = ['running', 'tool', 'waiting_approval', 'done', 'error', 'disconnected'];
  const labelHeight = 9;
  const cellW = width / HOSTS.length;
  const cellH = (height - labelHeight) / states.length;
  ctx.fillStyle = '#9a9aa6';
  HOSTS.forEach((host, index) => {
    ctx.fillText(host.short, index * cellW + 2, 0);
  });
  for (let row = 0; row < states.length; row += 1) {
    for (let col = 0; col < HOSTS.length; col += 1) {
      const count = state.sessions.filter((session) => session.host === HOSTS[col].id && session.state === states[row]).length;
      const intensity = count === 0 ? 0 : Math.min(1, 0.3 + count * 0.3);
      ctx.fillStyle = count === 0 ? '#0c0c10' : `rgba(214,214,222,${intensity})`;
      ctx.fillRect(col * cellW + 1, labelHeight + row * cellH + 1, Math.max(1, cellW - 2), Math.max(1, cellH - 1));
    }
  }
  ctx.strokeStyle = '#2c2c35';
  ctx.strokeRect(0.5, labelHeight + 0.5, width - 1, height - labelHeight - 1);
}

/** Evidence Inspector: formula, inputs, sample size and limitation for a panel. */
function showEvidence(kind) {
  if (!els.labEvidence || !els.labEvidenceBody) return;
  const rows = [];
  const add = (label, value) => rows.push([label, value == null || value === '' ? '—' : String(value)]);
  if (kind === 'rate') {
    const meta = METRIC_REGISTRY.eventRate;
    els.labEvidenceTitle.textContent = 'TOOL EVENT RATE · EVIDENCE';
    add('FORMULA', meta.formula);
    add('WINDOW', lastRate ? `${lastRate.windowMs / 1000}s · ${lastRate.bucketMs / 1000}s buckets` : '120s');
    add('SAMPLES', lastRate ? lastRate.count : 0);
    add('λ', lastRate ? `${lastRate.lambdaPerSecond.toFixed(3)} events/s` : '—');
    add('EVIDENCE', lastRate ? lastRate.evidence : 'UNKNOWN');
    add('LIMITATION', meta.limitation);
  } else if (kind === 'failure') {
    els.labEvidenceTitle.textContent = 'FAILURE TRACE · EVIDENCE';
    add('FORMULA', 'count of error / tool.fail timestamps inside the 120 s window');
    add('WINDOW', '120 s');
    add('SAMPLES', lastFailureCount);
    add('EVIDENCE', 'OBSERVED_NATIVE if source=host-native; otherwise DERIVED/SIMULATED');
    add('LIMITATION', 'no failure events is NOT a validation pass; PASS/FAIL stays unknown');
  } else {
    els.labEvidenceTitle.textContent = 'AGENT ACTIVITY MATRIX · EVIDENCE';
    add('FORMULA', 'count of sessions per host × observed state');
    add('SAMPLES', state.sessions.length);
    add('HOSTS', projectionHostCount());
    add('EVIDENCE', 'OBSERVED_NATIVE / DERIVED / SIMULATED per event');
    add('LIMITATION', 'empty cells mean no session in that state, not a healthy state');
  }
  clearNode(els.labEvidenceBody);
  for (const [label, value] of rows) {
    const row = make('div');
    row.append(make('span', '', label), make('strong', '', value));
    els.labEvidenceBody.appendChild(row);
  }
  els.labEvidence.hidden = false;
}

function projectionHostCount() {
  return new Set(state.sessions.map((session) => session.host)).size;
}

function showTraceEvidence(row) {
  if (!els.labEvidence || !els.labEvidenceBody) return;
  els.labEvidenceTitle.textContent = 'TOOL CALL · EVIDENCE';
  clearNode(els.labEvidenceBody);
  const entries = [
    ['EVENT ID', row.eventId || '—'],
    ['SESSION', row.sessionId || '—'],
    ['RUN', row.runId || '—'],
    ['TOOL CALL', row.toolCallId || '—'],
    ['SOURCE', `${row.source || 'unknown'} / ${row.confidence || 'unknown'}`],
    ['STATUS', row.status || '—'],
    ['DURATION', row.durationMs == null ? '—' : `${row.durationMs} ms`],
    ['LIMITATION', 'cache/replay events only; duration is derived from matched start/end'],
  ];
  for (const [label, value] of entries) {
    const line = make('div');
    line.append(make('span', '', label), make('strong', '', String(value)));
    els.labEvidenceBody.appendChild(line);
  }
  els.labEvidence.hidden = false;
}

function setTraceTab(tab) {
  traceTab = tab;
  for (const [key, button] of [['waterfall', els.traceWaterfallTab], ['dag', els.traceDagTab], ['critical', els.traceCriticalTab]]) {
    if (button) button.setAttribute('aria-selected', String(key === tab));
  }
  clearNode(els.traceBody);
  if (tab === 'waterfall') {
    const result = toolWaterfall(state.events);
    els.traceBody.appendChild(make('h4', '', `TOOL WATERFALL · ${result.rows.length} PAIRS · ${result.uncorrelated} UNCORRELATED`));
    for (const row of [...result.rows].reverse()) {
      const line = make('div', 'trace-row', `${formatClock(row.timestamp)} · ${row.toolName || '—'} · ${row.status} · ${row.durationMs == null ? '—' : `${row.durationMs} ms`} · ${row.source || 'unknown'} · ${row.eventId || 'no eventId'}`);
      line.dataset.status = row.status;
      line.tabIndex = 0;
      line.setAttribute('role', 'button');
      line.title = `${row.eventId || 'no eventId'} · ${row.toolCallId || 'no callId'} · ${row.source || 'unknown'}`;
      const open = () => showTraceEvidence(row);
      line.addEventListener('click', open);
      line.addEventListener('keydown', (domEvent) => { if (domEvent.key === 'Enter') open(); });
      els.traceBody.appendChild(line);
    }
    if (result.rows.length === 0) els.traceBody.appendChild(make('div', 'trace-note', 'NO CORRELATED TOOL CALLS IN CACHE · TIMELINE ONLY'));
    els.traceBody.appendChild(make('div', 'trace-note', 'Every row maps to a stored/cached eventId; unpaired calls stay UNCORRELATED.'));
  } else if (tab === 'dag') {
    const spans = state.events.filter((event) => event.spanId || event.parentSpanId || event.traceId);
    els.traceBody.appendChild(make('h4', '', `EXECUTION DAG · ${spans.length} SPAN-TAGGED EVENTS`));
    if (spans.length === 0) {
      els.traceBody.appendChild(make('div', 'trace-note', 'NO TRUSTED DEPENDENCY EDGES · TIMELINE ONLY'));
      for (const event of state.events.slice(-20).reverse()) {
        els.traceBody.appendChild(make('div', 'trace-row', `${formatClock(event.timestamp)} · ${event.eventType} · ${event.source || 'unknown'} · ${event.eventId || 'no eventId'}`));
      }
    } else {
      for (const event of spans.slice(-30)) {
        const parent = event.parentSpanId ? state.events.find((candidate) => candidate.spanId === event.parentSpanId) : null;
        els.traceBody.appendChild(make('div', 'trace-row', `${event.spanId || '—'} ← ${parent ? `${parent.spanId} (${parent.eventId || 'no id'})` : 'UNKNOWN PARENT'}`));
      }
    }
    els.traceBody.appendChild(make('div', 'trace-note', 'Edges are shown only when parentSpanId matches an observed spanId; otherwise UNKNOWN.'));
  } else {
    const tasks = state.events
      .filter((event) => event.taskId && event.dependsOn)
      .map((event) => ({ id: event.taskId, dependsOn: event.dependsOn, durationMs: event.durationMs }));
    const result = criticalPath(tasks);
    els.traceBody.appendChild(make('h4', 'CRITICAL PATH'));
    els.traceBody.appendChild(make('div', 'trace-note', result.durationMs == null
      ? 'UNKNOWN · no trusted task dependency graph in the observed events. Formula available, data absent.'
      : `${result.durationMs} ms · path ${result.path.join(' → ')}`));
    els.traceBody.appendChild(make('div', 'trace-note', 'T = max_path Σ duration_i; requires explicit dependsOn edges.'));
  }
}

function openTrace() {
  if (!els.tracePanel) return;
  els.tracePanel.hidden = false;
  setTraceTab('waterfall');
}
function renderLabMonitor() {
  if (!els.labFeedRows) return;
  const projection = projectMonitor({
    hosts: HOSTS,
    sessions: state.sessions,
    events: state.events,
    selectedSessionId: state.selectedSessionId,
    mode: state.mode,
  });
  const active = projection.selected;
  els.labHeadCount.textContent = `${projection.observedHostCount}/${projection.hostCount} HOSTS · ${projection.sessionCount} SESSIONS · ${projection.eventCount} EVENTS`;
  els.labFeedStatus.textContent = projection.mode === 'simulated' ? 'SIMULATED' : projection.mode.toUpperCase();
  if (els.labMasthead) {
    els.labKpiHosts.textContent = `${projection.observedHostCount}/${projection.hostCount}`;
    els.labKpiSessions.textContent = String(projection.sessionCount);
    els.labKpiEvents.textContent = String(projection.eventCount);
    els.labKpiTools.textContent = String(projection.toolEventCount);
    els.labKpiErrors.textContent = String(projection.errorEventCount);
  }

  const feedEvents = projection.recent.filter((event) => {
    if (state.feedFilter === 'tool') return typeof event.kind === 'string' && event.kind.startsWith('tool.');
    if (state.feedFilter === 'error') return typeof event.kind === 'string' && /error|fail/i.test(event.kind);
    if (state.feedFilter === 'output') return typeof event.kind === 'string' && event.kind.startsWith('output.');
    return true;
  });
  if (!state.feedPaused) {
    clearNode(els.labFeedRows);
    if (feedEvents.length === 0) {
      els.labFeedRows.appendChild(make('li', 'lab-empty', '— 等待事件桥提供可观测事件'));
    }
    for (const event of feedEvents) {
      const row = make('li', 'lab-feed-row');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.dataset.key = event.key;
      row.setAttribute('aria-selected', String(state.feedSelectedKey === event.key));
      row.title = `${event.host || 'unknown host'} · ${event.source}`;
      row.append(make('time', '', event.timestamp === null ? '—' : formatClock(event.timestamp)));
      row.append(make('b', '', event.kind));
      row.append(make('span', '', event.tool || '—'));
      row.append(make('i', '', event.source === 'simulated' ? 'SIM' : event.source === 'host-native' ? 'NAT' : event.source === 'derived' ? 'DRV' : 'UNK'));
      const select = () => {
        state.feedSelectedKey = event.key;
        renderFeedDetail(event);
        for (const other of els.labFeedRows.querySelectorAll('.lab-feed-row')) {
          other.setAttribute('aria-selected', String(other.dataset.key === event.key));
        }
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (domEvent) => {
        if (domEvent.key === 'Enter' || domEvent.key === ' ') { domEvent.preventDefault(); select(); }
      });
      els.labFeedRows.appendChild(row);
    }
    if (state.feedSelectedKey && !projection.recent.some((event) => event.key === state.feedSelectedKey)) {
      state.feedSelectedKey = null;
      renderFeedDetail(null);
    }
  }

  // Micro canvases: every pixel is derived from cached observed events.
  const selectedEvents = state.events.filter((event) => event.sessionId === state.selectedSessionId);
  drawRateCanvas(selectedEvents);
  drawFailureCanvas(selectedEvents);
  drawMatrixCanvas();
  els.labToolSummary.textContent = `TOOL ${projection.selectedToolEventCount} / CACHED ${projection.eventCount}`;

  const detail = (target, entries) => {
    clearNode(target);
    for (const [label, value] of entries) {
      const row = make('div', 'lab-detail');
      row.append(make('span', '', label), make('strong', '', String(value)));
      target.appendChild(row);
    }
  };
  const unknown = (value) => value == null || value === '' ? '—' : value;
  const metric = (value) => value == null ? '—' : String(value);
  const toolLine = active?.toolName
    ? `${active.toolName} · ${active.lastToolDurationMs == null ? '—' : `${active.lastToolDurationMs} ms`} · ${active.lastToolCorrelated ? 'CORRELATED' : (active.selectedToolEventCount ? 'UNCORRELATED' : '—')}`
    : '—';
  detail(els.labWorkspaceDetails, [
    ['HOST / STATE', active ? `${active.host} / ${active.state}` : '— / disconnected'],
    ['MODEL', unknown(active?.model)],
    ['STEP / TURN', active ? `${metric(active.step)} / ${metric(active.turn)}` : '— / —'],
    ['TOOL / DURATION', toolLine],
    ['TOKENS / S', metric(active?.tokensPerSecond)],
  ]);
  detail(els.labSourceDetails, [
    ['TRANSPORT', projection.mode.toUpperCase()],
    ['SOURCE', unknown(active?.source)],
    ['CONFIDENCE', unknown(active?.confidence)],
    ['CONTEXT USED', metric(active?.contextUsed)],
    ['CONTEXT LIMIT', metric(active?.contextLimit)],
  ]);
  detail(els.labValidationDetails, [
    ['ERROR EVENTS / CACHE', String(projection.errorEventCount)],
    ['WARNING FLAGS', active ? String(active.warnings.length) : '—'],
    ['HOST VERIFICATION', 'SEE HOST MATRIX'],
    ['PASS / FAIL', '— / —'],
    ['OBSERVATION', `120s WINDOW · ${projection.selectedEventCount} CACHED`],
  ]);
  detail(els.labTypeDetails, projection.types.length ? projection.types.map(([key, countValue]) => [key, countValue]) : [['EVENT TYPES', '—']]);

  const graph = state.obsidianMetadata;
  detail(els.labKnowledgeDetails, graph ? [
    ['NOTES', graph.notes.toLocaleString()],
    ['RESOLVED LINKS', graph.links.toLocaleString()],
    ['FOLDERS', graph.folders.toLocaleString()],
    ['SOURCE', 'LOCAL JSON SNAPSHOT'],
    ['SYNC', 'STATIC / NO LIVE ACCESS'],
  ] : [
    ['VAULT', 'NOT CONNECTED'],
    ['LINK GRAPH', '—'],
    ['ACCESS', '未授权 · 不读取笔记'],
  ]);

  clearNode(els.labHosts);
  for (const host of projection.hosts) {
    const row = make('button', 'lab-host');
    row.type = 'button';
    row.dataset.host = host.id;
    row.dataset.state = host.state;
    row.setAttribute('aria-pressed', String(host.selected));
    row.append(make('span', 'lab-host-short', host.short));
    row.append(make('span', 'lab-host-state', `${host.state}${host.count ? ` · ${host.count}` : ''}`));
    row.title = `${host.id} — ${host.source || 'no session'}`;
    row.addEventListener('click', () => selectHost(host.id));
    els.labHosts.appendChild(row);
  }
}

function renderMode() {
  const session = selectedSession();
  const simulated = state.mode === 'simulated' || !!(session && session.source === 'simulated');
  const mode = simulated ? 'simulated' : state.mode;

  if (els.linkStatus) els.linkStatus.dataset.mode = mode;
  if (els.linkText) {
    if (mode === 'simulated') els.linkText.textContent = '模拟演示 · 非真机数据';
    else if (mode === 'live') els.linkText.textContent = `实时 · ${state.snapshot?.bridge?.version ? `bridge ${state.snapshot.bridge.version}` : 'SSE'}`;
    else if (mode === 'offline') els.linkText.textContent = '连接中断 · 数据可能过期';
    else els.linkText.textContent = '连接事件桥';
  }
  if (els.watermark) els.watermark.hidden = !simulated;
  document.body.classList.toggle('is-simulated', simulated);

  if (els.feedMode) {
    const feedMode = state.mode === 'simulated' ? 'simulated' : state.mode === 'live' ? 'live' : state.mode === 'offline' ? 'offline' : 'connecting';
    els.feedMode.dataset.mode = feedMode;
    els.feedMode.textContent = feedMode === 'simulated' ? '示例' : feedMode === 'live' ? 'LIVE' : feedMode === 'offline' ? 'STALE' : '—';
  }
}

/** 320×320 mini HUD: one state badge, one agent line, source + fps. */
function renderCompact() {
  if (!els.compactHud) return;
  const compact = isCompactLayout();
  document.body.classList.toggle('mode-compact', compact);
  els.compactHud.hidden = !compact;
  if (!compact) return;

  const session = selectedSession();
  const stateName = session ? session.state : 'disconnected';
  const meta = STATE_META[stateName] || STATE_META.disconnected;
  if (els.compactState) els.compactState.style.setProperty('--state-color', meta.color);
  if (els.compactStateLabel) {
    els.compactStateLabel.textContent = session ? `${meta.labelZh} · ${meta.labelEn}` : '无会话';
  }
  if (els.compactAgent) {
    if (session) {
      const host = HOST_BY_ID.get(session.host);
      els.compactAgent.textContent = `${host ? host.name : session.host} · ${session.sessionId}`;
    } else {
      els.compactAgent.textContent = state.mode === 'simulated'
        ? '模拟流 · 等待会话'
        : state.mode === 'live' ? '实时桥已连接 · 等待会话' : '等待事件桥';
    }
  }
  if (els.compactSource) {
    if (session) {
      // source label + confidence *value*: for derived/inferred the two Chinese
      // labels would otherwise read as a redundant "推断 · 推断".
      els.compactSource.textContent = `${sourceBadge(session.source).labelZh} · ${confidenceBadge(session.confidence).labelEn}`;
    } else {
      els.compactSource.textContent = state.mode === 'simulated' ? '模拟 · SIMULATED' : '—';
    }
  }
  if (els.compactFps) {
    const fps = state.stats && state.stats.fps > 0 ? Math.round(state.stats.fps) : null;
    els.compactFps.textContent = fps ? `${fps} fps` : '— fps';
  }
}

function isCompactLayout() {
  return appMode === 'compact' || (typeof window.innerWidth === 'number' && window.innerWidth < 480);
}

function setAppMode(mode) {
  const next = String(mode || '').toLowerCase();
  if (!['window', 'overlay', 'compact'].includes(next)) return;
  appMode = next;
  document.body.dataset.mode = next;
  renderCompact();
}

function applyResponsiveMode() {
  document.body.dataset.mode = appMode;
  document.body.dataset.preset = state.preset;
  renderCompact();
  // The engine scales the ring with the viewport height; at 1280x720 the arc
  // reads ~6% larger than upstream. Only the Agent Monitor preset compensates,
  // other presets keep their authored composition.
  if (state.preset === 'agent-monitor' && typeof viz?.setParams === 'function') {
    viz.setParams({ scale: window.innerWidth < 1400 ? 0.78 : 0.86 });
  }
}

function renderSettings() {
  if (els.settingsMode) {
    els.settingsMode.textContent = state.mode === 'simulated'
      ? '模拟'
      : state.mode === 'live' ? '实时' : state.mode === 'offline' ? '中断' : '连接中';
  }
  if (els.settingsBridge) els.settingsBridge.textContent = BRIDGE_URL || '已拒绝（非 loopback）';
  if (els.settingsToken) els.settingsToken.textContent = TOKEN ? '已配置（不回显）' : '未配置';
  if (els.settingsTransport) {
    els.settingsTransport.textContent = state.mode === 'simulated'
      ? '本地模拟流 · 仅演示'
      : 'SSE · 只读';
  }
  if (els.settingsSnapshot) {
    els.settingsSnapshot.textContent = state.lastSnapshotAt ? formatClock(state.lastSnapshotAt) : '—';
  }
  if (els.settingsReason) {
    els.settingsReason.textContent = state.reason || '事件桥只在本机回环地址监听；token 不会写入界面。';
  }
}

function renderAll() {
  renderAgents();
  renderSessions();
  renderSession();
  renderEvents();
  renderMode();
  renderSettings();
  renderCompact();
  renderLabMonitor();
}

/* ------------------------------------------------------------------ *
 * selection
 * ------------------------------------------------------------------ */

function selectSession(sessionId) {
  const session = state.sessions.find((entry) => entry.sessionId === sessionId);
  if (!session) return;
  state.manualSelection = true;
  state.selectedSessionId = session.sessionId;
  state.selectedHost = session.host;
  viz.setSession(session);
  renderAll();
}

function selectHost(hostId) {
  const session = bestSessionForHost(hostId);
  state.manualSelection = true;
  state.selectedHost = hostId;
  if (session) {
    state.selectedSessionId = session.sessionId;
    viz.setSession(session);
  } else {
    state.selectedSessionId = null;
    viz.setSession(undefined);
  }
  renderAll();
}

function resolveSelectedSession(sessions, activeSessionId) {
  if (state.manualSelection) {
    if (state.selectedSessionId) {
      const found = sessions.find((session) => session.sessionId === state.selectedSessionId);
      if (found) return found;
    }
    if (state.selectedHost) {
      const hostSessions = sessions.filter((session) => session.host === state.selectedHost);
      if (hostSessions.length > 0) return pickPrimarySession(hostSessions);
      return null;
    }
  }
  if (state.preferredSessionId) {
    const preferred = sessions.find((session) => session.sessionId === state.preferredSessionId);
    if (preferred) return preferred;
  }
  if (activeSessionId) {
    const active = sessions.find((session) => session.sessionId === activeSessionId);
    if (active) return active;
  }
  return pickPrimarySession(sessions) || null;
}

/* ------------------------------------------------------------------ *
 * snapshots / events
 * ------------------------------------------------------------------ */

function unwrapSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.sessions)) return payload;
  if (payload.snapshot && Array.isArray(payload.snapshot.sessions)) return payload.snapshot;
  if (payload.data && Array.isArray(payload.data.sessions)) return payload.data;
  if (payload.state && Array.isArray(payload.state.sessions)) return payload.state;
  return null;
}

function parseSsePayload(event) {
  if (!event || typeof event.data !== 'string') return null;
  try {
    return unwrapSnapshot(JSON.parse(event.data));
  } catch {
    return null;
  }
}

function ingestEvents(sessions) {
  const existing = new Set(state.events.map((event) => event.key));
  for (const session of sessions) {
    for (const event of session.recentEvents || []) {
      const key = `${session.sessionId}|${event.timestamp}|${event.eventType}|${event.toolCallId || event.toolName || ''}`;
      if (existing.has(key)) continue;
      existing.add(key);
      state.events.push({
        key,
        eventId: event.eventId || '',
        sessionId: session.sessionId,
        host: session.host,
        // Per-event provenance. Never fall back to the session aggregate.
        source: typeof event.source === 'string' ? event.source : 'unknown',
        confidence: typeof event.confidence === 'string' ? event.confidence : 'unknown',
        eventType: event.eventType,
        timestamp: event.timestamp,
        toolName: event.toolName || '',
        toolCallId: event.toolCallId || '',
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
        errorCode: event.errorCode || '',
        label: event.label || '',
        runId: event.runId || '',
      });
    }
  }
  state.events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (state.events.length > 30) state.events = state.events.slice(state.events.length - 30);
}

function handleSnapshot(payload, kind) {
  const snapshot = unwrapSnapshot(payload);
  if (!snapshot) return;

  state.snapshot = snapshot;
  state.lastSnapshotAt = Date.now();
  state.hosts = new Map(
    (Array.isArray(snapshot.hosts) ? snapshot.hosts : [])
      .filter((entry) => entry && typeof entry.host === 'string')
      .map((entry) => [entry.host, entry]),
  );

  const sessions = (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
    .map((view) => normalizeSession(view))
    .filter(Boolean);
  state.sessions = sessions;

  const selected = resolveSelectedSession(sessions, snapshot.activeSessionId);
  state.selectedSessionId = selected ? selected.sessionId : null;
  if (selected) state.selectedHost = selected.host;
  else if (!state.manualSelection) state.selectedHost = null;

  viz.setSessions(sessions);
  viz.setSession(selected || undefined);
  ingestEvents(sessions);

  if (kind === 'live') {
    state.mode = 'live';
    state.reason = '';
    state.gotSnapshot = true;
    if (state.connectTimer) {
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
    }
  }

  renderAll();
}

/* ------------------------------------------------------------------ *
 * live SSE
 * ------------------------------------------------------------------ */

function closeEventSource() {
  if (state.connectTimer) {
    clearTimeout(state.connectTimer);
    state.connectTimer = null;
  }
  if (state.eventSource) {
    try { state.eventSource.close(); } catch { /* ignore */ }
    state.eventSource = null;
  }
}

function connectLive() {
  closeEventSource();
  stopMock();
  if (!BRIDGE_URL) {
    enterSimulated('已拒绝非 loopback 事件桥地址');
    return;
  }
  if (!TOKEN) {
    enterSimulated('未配置事件桥 token，进入模拟演示');
    return;
  }

  state.mode = 'connecting';
  state.reason = '已连接事件桥，等待首个快照';
  state.gotSnapshot = false;
  // Never mix a previous demo feed with real bridge snapshots.
  state.events = [];
  state.sessions = [];
  state.snapshot = null;
  renderAll();

  let source;
  try {
    source = new EventSource(`${BRIDGE_URL}/v1/stream?token=${encodeURIComponent(TOKEN)}`);
  } catch {
    enterSimulated('EventSource 不可用，进入模拟演示');
    return;
  }
  state.eventSource = source;

  state.connectTimer = setTimeout(() => {
    state.connectTimer = null;
    if (!state.gotSnapshot && state.eventSource === source) {
      enterSimulated(`无法连接 ${BRIDGE_URL}，进入模拟演示`);
    }
  }, 4500);

  const onSnapshot = (event) => {
    const snapshot = parseSsePayload(event);
    if (!snapshot) return;
    state.gotSnapshot = true;
    handleSnapshot(snapshot, 'live');
  };
  source.addEventListener('snapshot', onSnapshot);
  source.addEventListener('update', onSnapshot);
  source.onopen = () => {
    if (!state.gotSnapshot) {
      state.mode = 'connecting';
      state.reason = 'SSE 已打开，等待快照';
      renderAll();
    }
  };
  source.onerror = () => {
    if (!state.gotSnapshot) return; // the fallback timer owns the first-connect path
    state.mode = 'offline';
    state.reason = 'SSE 连接中断，保留最后快照；可能已过期';
    renderAll();
  };
}

/* ------------------------------------------------------------------ *
 * simulated demo
 * ------------------------------------------------------------------ */

function stopMock() {
  if (state.mock) {
    try { state.mock.stop(); } catch { /* ignore */ }
    state.mock = null;
  }
}

function enterSimulated(reason) {
  closeEventSource();
  stopMock();
  state.mode = 'simulated';
  state.reason = reason || '模拟演示 · 非真机数据';
  state.gotSnapshot = false;
  state.events = [];
  state.snapshot = null;
  state.sessions = [];
  state.hosts = new Map();
  state.selectedSessionId = null;
  state.selectedHost = null;
  state.manualSelection = false;
  renderAll();

  state.mock = createMockStream({
    multi: MULTI,
    initialState: PINNED_STATE || undefined,
    intervalMs: 3200,
    onSnapshot: (snapshot) => {
      handleSnapshot(snapshot, 'simulated');
    },
  });
  state.mock.start();
}

/* ------------------------------------------------------------------ *
 * stats
 * ------------------------------------------------------------------ */

function updateStats(stats) {
  if (!stats) return;
  state.stats = stats;
  if (els.perfFps) els.perfFps.textContent = stats.fps > 0 ? `${Math.round(stats.fps)} fps` : '— fps';
  if (els.perfFrame) els.perfFrame.textContent = stats.frameMs > 0 ? `${stats.frameMs.toFixed(1)} ms` : '— ms';
  if (els.perfQuality) {
    const label = ['高', '中', '低'][stats.qualityLevel] || '高';
    els.perfQuality.textContent = `画质 ${label} · ${Math.round((stats.quality || 1) * 100)}%`;
  }
  if (els.perfParticles) els.perfParticles.textContent = `${stats.particles || 0} particles`;
  if (els.statusVersion) els.statusVersion.textContent = `v0.1.0${stats.reducedMotion ? ' · reduce-motion' : ''}`;
  if (els.compactFps) {
    els.compactFps.textContent = stats.fps > 0 ? `${Math.round(stats.fps)} fps` : '— fps';
  }
  if (isCompactLayout()) renderCompact();
  if (stats.reducedMotion !== undefined && stats.reducedMotion !== state.reducedMotion) {
    state.reducedMotion = stats.reducedMotion;
    syncMotionControls();
  }
}

/* ------------------------------------------------------------------ *
 * UI events
 * ------------------------------------------------------------------ */

function bindEvents() {
  els.labObsidianFile?.addEventListener('change', async () => {
    const file = els.labObsidianFile.files?.[0];
    els.labObsidianFile.value = '';
    if (!file) return;
    if (file.size > 65536) {
      toast('元数据文件超过 64 KiB，已拒绝');
      return;
    }
    try {
      const parsed = parseObsidianMetadata(JSON.parse(await file.text()));
      if (!parsed) {
        toast('Obsidian 元数据格式不正确');
        return;
      }
      state.obsidianMetadata = parsed;
      renderLabMonitor();
      toast('仅已加载本地汇总数值 · 不读取笔记正文');
    } catch {
      toast('元数据 JSON 无法解析');
    }
  });
  els.labFeedFilter?.addEventListener('change', () => {
    state.feedFilter = els.labFeedFilter.value;
    renderLabMonitor();
  });
  els.labFeedPause?.addEventListener('click', () => {
    state.feedPaused = !state.feedPaused;
    els.labFeedPause.setAttribute('aria-pressed', String(state.feedPaused));
    els.labFeedPause.textContent = state.feedPaused ? 'RESUME' : 'PAUSE';
    if (!state.feedPaused) renderLabMonitor();
  });
  els.labRateCanvas?.addEventListener('click', () => showEvidence('rate'));
  els.labFailCanvas?.addEventListener('click', () => showEvidence('failure'));
  els.labMatrixCanvas?.addEventListener('click', () => showEvidence('matrix'));
  els.labEvidenceClose?.addEventListener('click', () => { if (els.labEvidence) els.labEvidence.hidden = true; });
  els.replayPlay?.addEventListener('click', () => {
    const replay = state.replay;
    if (!replay) return;
    if (replay.playing) {
      replay.playing = false;
      els.replayPlay.textContent = 'RESUME';
    } else {
      if (replay.elapsedMs >= replayDurationMs(replay.events)) replay.elapsedMs = 0;
      replay.playing = true;
      els.replayPlay.textContent = 'PAUSE';
    }
  });
  els.replayStep?.addEventListener('click', () => {
    const replay = state.replay;
    if (!replay) return;
    replay.playing = false;
    if (els.replayPlay) els.replayPlay.textContent = 'RESUME';
    const next = Math.min(replay.events.length - 1, replay.index + 1);
    replay.elapsedMs = Math.max(0, replay.events[next].timestamp - replay.events[0].timestamp);
    applyReplayFrame(next);
  });
  els.replaySpeed?.addEventListener('change', () => {
    if (state.replay) state.replay.speed = Number(els.replaySpeed.value) || 1;
  });
  els.replayClose?.addEventListener('click', stopReplay);
  els.btnTrace?.addEventListener('click', openTrace);
  els.traceClose?.addEventListener('click', () => { if (els.tracePanel) els.tracePanel.hidden = true; });
  els.traceWaterfallTab?.addEventListener('click', () => setTraceTab('waterfall'));
  els.traceDagTab?.addEventListener('click', () => setTraceTab('dag'));
  els.traceCriticalTab?.addEventListener('click', () => setTraceTab('critical'));
  els.btnParams?.addEventListener('click', () => openDrawer(els.paramsDrawer));
  els.btnSettings?.addEventListener('click', () => openDrawer(els.settingsDrawer));
  els.btnAbout?.addEventListener('click', openAbout);
  els.compactParams?.addEventListener('click', () => openDrawer(els.paramsDrawer));
  els.compactSettings?.addEventListener('click', () => openDrawer(els.settingsDrawer));
  els.compactAbout?.addEventListener('click', openAbout);

  document.querySelectorAll('[data-close-drawer]').forEach((button) => {
    button.addEventListener('click', closeDrawers);
  });
  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeAbout);
  });
  els.drawerBackdrop?.addEventListener('click', closeDrawers);
  els.aboutBackdrop?.addEventListener('click', closeAbout);

  els.toggleMotion?.addEventListener('click', () => setReducedMotion(!state.reducedMotion));
  els.toggleMotionSettings?.addEventListener('click', () => setReducedMotion(!state.reducedMotion));
  els.togglePause?.addEventListener('click', () => setPaused(!state.paused));
  els.btnPause?.addEventListener('click', () => setPaused(!state.paused));

  els.btnReconnect?.addEventListener('click', () => {
    toast('重新连接本机事件桥…');
    connectLive();
  });
  els.btnEnterMock?.addEventListener('click', () => {
    enterSimulated('手动进入模拟演示 · 非真机数据');
  });
  els.btnResetLocal?.addEventListener('click', () => {
    applyPreset('original', { persist: false, silent: true });
    setReducedMotion(false, false);
    try { window.localStorage.removeItem(PREFS_KEY); } catch { /* ignore */ }
    toast('已恢复原作预设与默认动效');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllOverlays();
  });

  window.addEventListener('resize', applyResponsiveMode);
  window.halofluxConfig?.mode && setAppMode(window.halofluxConfig.mode);

  // Optional Electron-shell bridge (during normal window / compact / overlay
  // operation). Safe on file:// previews where the preload does not exist.
  const shell = window.haloflux || window.halofluxCompanion || null;
  if (shell) {
    try {
      if (typeof shell.onStateChange === 'function') {
        shell.onStateChange((info) => {
          const mode = typeof info === 'string' ? info : (info && info.mode);
          if (mode) setAppMode(mode);
        });
      }
      if (typeof shell.onPause === 'function') {
        shell.onPause(() => { if (!state.paused) viz.pause(); });
      }
      if (typeof shell.onResume === 'function') {
        shell.onResume(() => { if (!state.paused) viz.resume(); });
      }
    } catch {
      /* shell integration is optional */
    }
  }

  window.addEventListener('beforeunload', () => {
    stopMock();
    closeEventSource();
    if (saveTimer) clearTimeout(saveTimer);
    if (toastTimer) clearTimeout(toastTimer);
    try { viz.destroy(); } catch { /* ignore */ }
  });
}

/* ------------------------------------------------------------------ *
 * QA hook (optional; harmless in production)
 * ------------------------------------------------------------------ */

function installQaHook() {
  const controls = els.qaStateControls;
  if (controls) {
    for (const stateName of AGENT_STATES) {
      const button = make('button', '', stateName);
      button.type = 'button';
      button.dataset.state = stateName;
      button.addEventListener('click', () => qaSetState(stateName));
      controls.appendChild(button);
    }
  }

  window.__halofluxQA = {
    ready: false,
    version: '0.1.0',
    setPreset(name) {
      if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) return false;
      applyPreset(name, { persist: false, silent: true });
      return true;
    },
    setState(stateName) {
      return qaSetState(stateName);
    },
    setSessions(views) {
      if (!Array.isArray(views)) return false;
      const sessions = views.map((view) => normalizeSession(view)).filter(Boolean);
      if (sessions.length === 0) return false;
      state.qaSessions = true;
      state.sessions = sessions;
      state.hosts = new Map(
        sessions.map((session) => [session.host, {
          host: session.host,
          hostVersion: session.hostVersion,
          connected: session.connected,
          capabilities: {},
        }]),
      );
      state.manualSelection = true;
      state.selectedSessionId = sessions[0].sessionId;
      state.selectedHost = sessions[0].host;
      viz.setSessions(sessions);
      viz.setSession(sessions[0]);
      renderAll();
      return true;
    },
    getStats() {
      const stats = viz.getStats();
      return {
        fps: stats.fps,
        frameMs: stats.frameMs,
        quality: stats.quality,
        particles: stats.particles,
        particlesByKind: stats.particlesByKind || null,
        preset: stats.preset,
        state: stats.state,
        source: stats.source,
        confidence: stats.confidence,
        simulated: stats.simulated,
        sessionId: stats.sessionId,
        sessions: stats.sessions,
        canvasWidth: stats.canvasWidth,
        canvasHeight: stats.canvasHeight,
        mode: state.mode,
        paused: state.paused,
      };
    },
    getSnapshot() {
      return state.snapshot;
    },
  };

  const markReady = () => { window.__halofluxQA.ready = true; };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(markReady);
  setTimeout(markReady, 50);
}

function qaSetState(stateName) {
  if (!STATE_META[stateName]) return false;
  if (state.mode !== 'simulated' || !state.mock) {
    enterSimulated('QA 状态截图 · 模拟数据');
  }
  if (!state.mock) return false;
  state.mock.setState(stateName);
  return true;
}

/* ------------------------------------------------------------------ *
 * replay (P3.2-A)
 * ------------------------------------------------------------------ */

function replayClock(ms) {
  const value = Math.max(0, Math.round(ms));
  const seconds = Math.floor(value / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${Math.floor((value % 1000) / 100)}`;
}

function applyReplayFrame(index) {
  const replay = state.replay;
  if (!replay) return;
  const bounded = Math.max(0, Math.min(replay.events.length - 1, index));
  replay.index = bounded;
  const session = sessionAt(replay.events, bounded, { sessionId: replay.sessionId });
  if (!session) return;
  state.sessions = [session];
  state.selectedSessionId = session.sessionId;
  state.selectedHost = session.host;
  state.events = replay.events.slice(0, bounded + 1);
  state.mode = 'replay';
  state.reason = 'REPLAY · local event store';
  viz.setSessions([session]);
  viz.setSession(session);
  renderAll();
  if (els.tracePanel && !els.tracePanel.hidden) setTraceTab(traceTab);
  if (els.replayClock) {
    els.replayClock.textContent = replayClock((replay.events[bounded].timestamp - replay.events[0].timestamp) || 0);
  }
}

function replayTick() {
  const replay = state.replay;
  if (!replay || !replay.playing) return;
  replay.elapsedMs += 200 * replay.speed;
  const duration = replayDurationMs(replay.events);
  if (replay.elapsedMs >= duration) {
    replay.elapsedMs = duration;
    replay.playing = false;
    if (els.replayPlay) els.replayPlay.textContent = 'RESUME';
  }
  const index = frameIndexAt(replay.events, replay.elapsedMs, 1);
  if (index !== replay.index) applyReplayFrame(index);
  else if (els.replayClock) {
    const offset = Math.min(duration, replay.elapsedMs);
    els.replayClock.textContent = replayClock(offset);
  }
}

async function startReplay(sessionId) {
  if (!sessionId || !TOKEN) return false;
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/history?sessionId=${encodeURIComponent(sessionId)}&limit=1000`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`history HTTP ${res.status}`);
    const data = await res.json();
    const events = sortEvents(data.events || []);
    if (events.length === 0) {
      toast('该会话没有可回放的历史事件');
      return false;
    }
    if (state.replay?.timer) clearInterval(state.replay.timer);
    state.replay = {
      sessionId, events, index: 0, elapsedMs: 0, speed: 1, playing: true,
      timer: setInterval(replayTick, 200),
    };
    if (els.replayBar) els.replayBar.hidden = false;
    if (els.replaySession) els.replaySession.textContent = `${sessionId.slice(0, 18)} · ${events.length} EVENTS · ${data.total || events.length} STORED`;
    if (els.replayPlay) els.replayPlay.textContent = 'PAUSE';
    if (Number.isFinite(REPLAY_AT)) {
      const index = Math.max(0, Math.min(events.length - 1, Math.floor(REPLAY_AT)));
      state.replay.elapsedMs = Math.max(0, events[index].timestamp - events[0].timestamp);
      state.replay.playing = false;
      state.replay.index = index;
      if (els.replayPlay) els.replayPlay.textContent = 'RESUME';
      applyReplayFrame(index);
    } else {
      applyReplayFrame(0);
      replayTick();
    }
    return true;
  } catch (error) {
    toast(`回放失败：${error && error.message ? error.message : 'unknown'}`);
    return false;
  }
}

function stopReplay() {
  if (state.replay?.timer) clearInterval(state.replay.timer);
  state.replay = null;
  if (els.replayBar) els.replayBar.hidden = true;
  const url = new URL(window.location.href);
  url.searchParams.delete('replay');
  window.location.href = url.toString();
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

function init() {
  buildPresetButtons();
  buildParamRows();
  syncMotionControls();
  syncPauseControls();
  bindEvents();
  applyResponsiveMode();

  viz.onStats(updateStats);
  viz.setStateHook((stats) => {
    if (stats && Number.isFinite(stats.fps)) updateStats(stats);
  });

  renderAll();

  if (REPLAY_SESSION) {
    startReplay(REPLAY_SESSION).then((ok) => {
      if (!ok) connectLive();
    });
  } else if (DEMO) {
    enterSimulated('演示模式 · ?demo=1');
  } else if (!BRIDGE_URL) {
    enterSimulated('已拒绝非 loopback 事件桥地址');
  } else if (!TOKEN) {
    enterSimulated('未配置事件桥 token，进入模拟演示');
  } else {
    connectLive();
  }

  installQaHook();

  // Deterministic recording/QA hook: seeks the replay cursor without wall-clock
  // timers, so offscreen capture produces a faithful replay progression.
  window.__halofluxReplaySeek = (offsetMs) => {
    const replay = state.replay;
    if (!replay) return false;
    replay.elapsedMs = Math.max(0, Number(offsetMs) || 0);
    replay.playing = false;
    if (els.replayPlay) els.replayPlay.textContent = 'RESUME';
    applyReplayFrame(frameIndexAt(replay.events, replay.elapsedMs, 1));
    return true;
  };

  if (TRACE_OPEN) openTrace();

  if (QA) {
    // QA runs need a stable first frame before screenshots.
    document.documentElement.dataset.qa = '1';
  }
}

init();
