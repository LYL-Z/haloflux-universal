/**
 * HALOFLUX Desktop Companion — Electron main process.
 *
 * Single instance, three window modes (window / overlay / compact), tray menu,
 * global shortcuts, safe IPC for the renderer, click-through overlay and
 * multi-display DPI handling.
 *
 * Environment contract (all optional; the launcher translates CLI flags to env
 * because Electron 43 on this machine can die on certain argv combinations):
 *   HALOFLUX_BRIDGE_URL   default http://127.0.0.1:<settings.bridge.port|17817>
 *   HALOFLUX_TOKEN        explicit token; otherwise $HALOFLUX_HOME/token
 *   HALOFLUX_MODE         window | overlay | compact
 *   HALOFLUX_DEMO         1 = show the simulated demo watermark
 *   HALOFLUX_CLICK_THROUGH 1|0
 *   HALOFLUX_OPACITY      overlay opacity 0.1..1
 *   HALOFLUX_SCREENSHOT   capturePage target PNG (evidence / CI)
 *   HALOFLUX_EXIT_AFTER   quit after N ms (headless smoke test)
 *   HALOFLUX_DEV          1 = enable devtools / dev menu
 *
 * GPU note: the Electron 43.3.0 build shipped with DeepSeek Harness crashes on
 * this machine when hardware acceleration is on, so it is disabled first thing.
 * `--disable-gpu-sandbox` is kept as a defensive switch; `--no-sandbox` is only
 * added when HALOFLUX_ELECTRON_NO_SANDBOX=1 (some CI sandboxes need it).
 */

import { app, BrowserWindow, Menu, globalShortcut, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadOrCreateSettings,
  settingsPath,
  updateSettings,
} from '../../../packages/settings/src/index.mjs';
import { ensureToken, tokenPath } from '../../../packages/event-bridge/src/token.mjs';
import {
  COMPANION_VERSION,
  COMPACT_SIZE,
  MODES,
  applyDisplayMetrics,
  applyModeToWindow,
  boundsWithDisplay,
  clampNumber,
  normalizeMode,
  resolveBounds,
  resolveZoomFactor,
  windowOptionsForMode,
} from './modes.js';
import { createTrayController } from './tray.js';

// GPU policy (updated after Lead verification): hardware acceleration is ON by
// default so the HUD does not slow the agent under test. It is disabled only for
// CI/screenshot runs with HALOFLUX_SOFTWARE_RENDER=1 (the Electron 43 build can
// crash on this machine for unrelated argv reasons; launcher retries with the
// software path if the GPU attempt dies before the window becomes ready).
const SOFTWARE_RENDER = process.env.HALOFLUX_SOFTWARE_RENDER === '1';
if (SOFTWARE_RENDER) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
if (process.env.HALOFLUX_ELECTRON_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(MAIN_DIR, '..');
const ROOT = path.resolve(APP_DIR, '..', '..');
const RENDERER_INDEX = path.join(APP_DIR, 'renderer', 'index.html');
const PRELOAD_PATH = path.join(APP_DIR, 'preload', 'preload.js');

// Passing a JS file to electron.exe makes Electron's app name default to
// "Electron" and its userData point at %APPDATA%\Electron, which is shared with
// every other Electron app on the machine (cache locks, bogus single-instance
// collisions). Pin an app-specific identity before requesting the instance lock.
app.setName('HALOFLUX Companion');
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'HALOFLUX-Companion'));
} catch (error) {
  console.error('[companion] could not set userData path:', error && error.message ? error.message : error);
}

const env = process.env;
const truthy = (value) => value === '1' || value === 'true' || value === 'yes';
const demo = truthy(env.HALOFLUX_DEMO);
const devMode = truthy(env.HALOFLUX_DEV);

const settingsFile = env.HALOFLUX_SETTINGS_FILE ? path.resolve(env.HALOFLUX_SETTINGS_FILE) : settingsPath();
let settings = loadOrCreateSettings(settingsFile);

const bridgeUrl = (
  env.HALOFLUX_BRIDGE_URL ||
  `http://127.0.0.1:${env.HALOFLUX_BRIDGE_PORT || settings.bridge.port || 17817}`
).replace(/\/+$/, '');

let tokenInfo;
try {
  tokenInfo = ensureToken({ env, file: env.HALOFLUX_TOKEN_FILE || tokenPath(env) });
} catch (error) {
  log(`token initialization failed: ${error && error.message ? error.message : error}`);
  tokenInfo = { token: env.HALOFLUX_TOKEN || '', source: 'none', path: tokenPath(env), created: false };
}

let mode = normalizeMode(env.HALOFLUX_MODE || settings.companion.mode);
let clickThrough = env.HALOFLUX_CLICK_THROUGH !== undefined
  ? truthy(env.HALOFLUX_CLICK_THROUGH)
  : Boolean(settings.companion.clickThrough);
let opacity = clampNumber(
  env.HALOFLUX_OPACITY !== undefined ? Number(env.HALOFLUX_OPACITY) : settings.companion.opacity,
  0.1,
  1,
);

let win = null;
let tray = null;
let quitting = false;
let shownOnce = false;
let boundsSaveTimer = null;
let screenshotTimer = null;
let screenshotDone = false;
const boundsByMode = new Map();

const screenshotPath = env.HALOFLUX_SCREENSHOT ? path.resolve(ROOT, env.HALOFLUX_SCREENSHOT) : '';
const exitAfterMs = Number.isFinite(Number(env.HALOFLUX_EXIT_AFTER)) ? Math.max(0, Number(env.HALOFLUX_EXIT_AFTER)) : 0;
const isSelftest = truthy(env.HALOFLUX_SELFTEST);

function log(...args) {
  console.log('[companion]', ...args);
}

function signalReadyFile(details = {}) {
  const readyFile = env.HALOFLUX_READY_FILE;
  if (!readyFile) return;
  try {
    fs.writeFileSync(
      readyFile,
      JSON.stringify(
        {
          status: 'ready',
          pid: process.pid,
          softwareRender: SOFTWARE_RENDER,
          mode,
          bridgeUrl,
          at: new Date().toISOString(),
          ...details,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    log(`could not write ready file: ${error && error.message ? error.message : error}`);
  }
}

process.on('uncaughtException', (error) => {
  console.error('[companion] uncaught exception:', error && error.stack ? error.stack : error);
});
process.on('unhandledRejection', (error) => {
  console.error('[companion] unhandled rejection:', error && error.stack ? error.stack : error);
});

function stateSnapshot() {
  return {
    mode,
    clickThrough,
    opacity,
    alwaysOnTop: mode === 'overlay' || mode === 'compact' || Boolean(settings.companion.alwaysOnTop),
    visible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    bridgeUrl,
    demo,
    version: COMPANION_VERSION,
    platform: process.platform,
    settings: {
      preset: settings.preset,
      visual: settings.visual,
      companion: settings.companion,
    },
    display: win && !win.isDestroyed()
      ? (() => {
          const display = screen.getDisplayMatching(win.getBounds());
          return {
            id: display.id,
            scaleFactor: display.scaleFactor,
            zoomFactor: win.webContents.getZoomFactor(),
            bounds: display.bounds,
            workArea: display.workArea,
          };
        })()
      : null,
  };
}

function infoSnapshot() {
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return {
    ...stateSnapshot(),
    token: tokenInfo.token,
    tokenSource: tokenInfo.source,
    tokenFile: tokenInfo.path,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    arch: process.arch,
    root: ROOT,
    renderer: RENDERER_INDEX,
    settingsFile,
    display: {
      id: display.id,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      workArea: display.workArea,
    },
  };
}

function persistCompanion(patch) {
  try {
    settings = updateSettings(settingsFile, { companion: patch });
    return true;
  } catch (error) {
    log(`settings update failed: ${error && error.message ? error.message : error}`);
    return false;
  }
}

function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* renderer not ready */
  }
}

function broadcastState() {
  sendToRenderer('haloflux:state', stateSnapshot());
  if (tray) tray.update({ ...stateSnapshot(), bridgeUrl, demo });
}

function lifecycle(type) {
  sendToRenderer('haloflux:lifecycle', type);
}

function rememberCurrentBounds() {
  if (!win || win.isDestroyed()) return null;
  const bounds = boundsWithDisplay(win.getBounds());
  boundsByMode.set(mode, bounds);
  return bounds;
}

function scheduleBoundsSave() {
  if (!win || win.isDestroyed() || !shownOnce) return;
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    if (!win || win.isDestroyed()) return;
    const bounds = rememberCurrentBounds();
    if (bounds) persistCompanion({ mode, bounds });
  }, 400);
}

function wireWindow(target) {
  target.on('resize', scheduleBoundsSave);
  target.on('move', scheduleBoundsSave);

  target.on('hide', () => {
    lifecycle('pause');
    broadcastState();
  });
  target.on('show', () => {
    lifecycle('resume');
    broadcastState();
  });
  target.on('minimize', () => lifecycle('pause'));
  target.on('restore', () => lifecycle('resume'));
  target.on('closed', () => {
    if (win === target) win = null;
    broadcastState();
  });

  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault();
  });
  target.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log(`renderer load failed (${errorCode} ${errorDescription}) url=${validatedURL}`);
  });
  target.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer process gone: ${details && details.reason ? details.reason : 'unknown'}`);
  });
  target.webContents.on('preload-error', (_event, preloadPath, error) => {
    log(`preload error (${preloadPath}): ${error && error.message ? error.message : error}`);
  });
  target.webContents.on('console-message', (event, level, message) => {
    const text = message !== undefined ? message : event && event.message;
    const severity = level !== undefined ? level : event && event.level;
    if (severity === 'error' || severity === 3) log(`renderer console: ${text}`);
  });
  target.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && mode === 'window') {
      event.preventDefault();
      target.setFullScreen(!target.isFullScreen());
    }
  });
}

function fallbackPage(reason) {
  const safe = (value) => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>HALOFLUX Companion</title>
<style>
  html,body{margin:0;height:100%;background:#0a0b0f;color:#dbe7ff;font:14px/1.6 "Segoe UI",system-ui,sans-serif}
  main{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:10px;padding:24px;text-align:center;background:radial-gradient(circle at 50% 40%,#123 0,#0a0b0f 62%)}
  h1{font-size:20px;letter-spacing:.18em;font-weight:600;margin:0}
  .ring{width:120px;height:120px;border-radius:50%;border:2px solid #35d6f0;box-shadow:0 0 30px #1e9fc0,inset 0 0 22px #1e9fc0}
  code{color:#8fe8ff}
  p{margin:0;opacity:.8;max-width:560px}
</style></head><body><main>
<div class="ring"></div>
<h1>HALOFLUX</h1>
<p>桌面壳已启动 · 模式 <code>${safe(mode)}</code></p>
<p>${safe(reason)}</p>
<p>Bridge: <code>${safe(bridgeUrl)}</code></p>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function loadRenderer(target) {
  if (fs.existsSync(RENDERER_INDEX)) {
    const query = { mode, demo: demo ? '1' : '0', bridge: bridgeUrl };
    return target.loadFile(RENDERER_INDEX, { query }).catch((error) => {
      log(`loadFile failed: ${error && error.message ? error.message : error}`);
    });
  }
  log(`renderer missing at ${RENDERER_INDEX}; showing diagnostic fallback page`);
  return target.loadURL(fallbackPage('renderer/index.html 尚未生成（visual-dev），显示诊断页。')).catch((error) => {
    log(`fallback load failed: ${error && error.message ? error.message : error}`);
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (mode === 'overlay') win.showInactive();
  else win.show();
  if (mode !== 'overlay') win.focus();
  broadcastState();
}

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide();
}

function toggleVisibility() {
  if (!win || win.isDestroyed() || !win.isVisible()) showWindow();
  else hideWindow();
}

function createWindow() {
  if (quitting) return;
  const saved = boundsByMode.get(mode) || (settings.companion.mode === mode ? settings.companion.bounds : null);
  const bounds = resolveBounds({ mode, savedBounds: saved });
  const display = screen.getDisplayMatching(bounds);
  const zoomFactor = resolveZoomFactor(display, env.HALOFLUX_COMPANION_ZOOM);
  const options = windowOptionsForMode({
    mode,
    bounds,
    preloadPath: PRELOAD_PATH,
    settings,
    demo,
    devTools: devMode,
    zoomFactor,
  });
  const target = new BrowserWindow(options);
  win = target;
  shownOnce = false;

  // Compact is specified as a 320×320 content viewport; some Windows builds add
  // a few DIPs of invisible border to frameless windows even with useContentSize.
  if (mode === 'compact') {
    try {
      target.setContentSize(COMPACT_SIZE.width, COMPACT_SIZE.height);
    } catch {
      /* older Electron; the useContentSize option still applies */
    }
  }

  try {
    target.webContents.setZoomFactor(zoomFactor);
  } catch {
    /* not ready; re-applied on ready-to-show */
  }
  try {
    target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.webContents.session.setPermissionCheckHandler(() => false);
  } catch {
    /* older Electron */
  }

  wireWindow(target);

  const reveal = () => {
    if (shownOnce || quitting || win !== target || target.isDestroyed()) return;
    shownOnce = true;
    applyModeToWindow(target, {
      mode,
      clickThrough,
      opacity,
      alwaysOnTop: Boolean(settings.companion.alwaysOnTop),
    });
    applyDisplayMetrics(target, { mode, zoomOverride: env.HALOFLUX_COMPANION_ZOOM });
    if (mode === 'overlay') target.showInactive();
    else target.show();
    if (mode !== 'overlay') target.focus();
    const activeBounds = rememberCurrentBounds();
    if (activeBounds) persistCompanion({ mode, bounds: activeBounds });
    broadcastState();
    log(`window ready mode=${mode} demo=${demo ? '1' : '0'} bridge=${bridgeUrl} softwareRender=${SOFTWARE_RENDER}`);
    log(
      `window flags visible=${target.isVisible()} alwaysOnTop=${target.isAlwaysOnTop()} ` +
        `skipTaskbar=${typeof target.isSkipTaskbar === 'function' ? target.isSkipTaskbar() : 'n/a'} ` +
        `opacity=${target.getOpacity()} clickThrough=${mode === 'overlay' ? (clickThrough ? 'on' : 'off') : 'n/a'} ` +
        `bounds=${JSON.stringify(target.getBounds())} dpr=${screen.getDisplayMatching(target.getBounds()).scaleFactor}`,
    );
    signalReadyFile({ mode, bounds: target.getBounds() });
    if (isSelftest) log('selftest ready');
    maybeScheduleScreenshot();
  };

  target.once('ready-to-show', reveal);
  target.webContents.on('did-finish-load', () => {
    if (!shownOnce) reveal();
    if (isSelftest) {
      target.webContents
        .executeJavaScript(
          `(async () => {
            const info = window.haloflux ? await window.haloflux.getInfo() : null;
            return {
              hasApi: Boolean(window.haloflux),
              keys: Object.keys(window.haloflux || {}),
              hasConfig: Boolean(window.halofluxConfig),
              tokenPresent: Boolean(window.halofluxConfig && window.halofluxConfig.token),
              mode: window.halofluxConfig && window.halofluxConfig.mode,
              dpr: window.devicePixelRatio,
              viewport: [window.innerWidth, window.innerHeight],
              screen: [window.screen.width, window.screen.height],
              asyncInfo: info ? {
                mode: info.mode,
                bridgeUrl: info.bridgeUrl,
                tokenPresent: Boolean(info.token),
                clickThrough: info.clickThrough,
                opacity: info.opacity,
                visible: info.visible,
              } : null,
            };
          })()`,
          true,
        )
        .then((result) =>
          log(
            `selftest probe: hasApi=${result && result.hasApi} hasConfig=${result && result.hasConfig} ` +
              `tokenPresent=${result && result.tokenPresent} mode=${result && result.mode} ` +
              `dpr=${result && result.dpr} viewport=${result && result.viewport ? result.viewport.join('x') : '?'} ` +
              `asyncInfo=${JSON.stringify(result && result.asyncInfo)}`,
          ),
        )
        .catch((error) => log(`preload probe failed: ${error && error.message ? error.message : error}`));
    }
  });

  loadRenderer(target);
}

function setMode(nextMode) {
  const normalized = normalizeMode(nextMode, mode);
  if (normalized === mode) return stateSnapshot();
  rememberCurrentBounds();
  mode = normalized;
  applyModeToWindow(win, {
    mode,
    clickThrough,
    opacity,
    alwaysOnTop: Boolean(settings.companion.alwaysOnTop),
  });
  persistCompanion({ mode });
  const previous = win;
  win = null;
  if (previous && !previous.isDestroyed()) previous.destroy();
  createWindow();
  broadcastState();
  return stateSnapshot();
}

function setOpacity(nextOpacity) {
  opacity = clampNumber(Number(nextOpacity), 0.1, 1);
  if (mode === 'overlay' && win && !win.isDestroyed()) {
    win.setOpacity(opacity);
  }
  persistCompanion({ opacity });
  broadcastState();
  return stateSnapshot();
}

function setClickThrough(enabled) {
  clickThrough = Boolean(enabled);
  if (mode === 'overlay' && win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
  }
  persistCompanion({ clickThrough });
  broadcastState();
  return stateSnapshot();
}

function cycleMode() {
  const index = MODES.indexOf(mode);
  return setMode(MODES[(index + 1) % MODES.length]);
}

function quitApp(reason = 'user') {
  if (quitting) return;
  quitting = true;
  log(`quitting (${reason})`);
  rememberCurrentBounds();
  try {
    persistCompanion({ mode, bounds: boundsByMode.get(mode) || settings.companion.bounds, clickThrough, opacity });
  } catch {
    /* never block quit on settings */
  }
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  if (screenshotTimer) clearTimeout(screenshotTimer);
  globalShortcut.unregisterAll();
  for (const candidate of BrowserWindow.getAllWindows()) {
    try {
      candidate.destroy();
    } catch {
      /* already gone */
    }
  }
  if (tray) tray.destroy();
  app.quit();
  // app.quit() can hang if a renderer or the tray refuses to release; guarantee
  // process termination so --exit-after and the tray Quit item really exit.
  const forceExitTimer = setTimeout(() => {
    log('app.quit() did not finish; forcing app.exit(0)');
    app.exit(0);
  }, 1500);
  void forceExitTimer;
}

function maybeScheduleScreenshot() {
  if (!screenshotPath || screenshotDone) return;
  screenshotDone = true;
  if (screenshotTimer) clearTimeout(screenshotTimer);
  const delay = Number.isFinite(Number(env.HALOFLUX_SCREENSHOT_DELAY))
    ? Math.max(0, Number(env.HALOFLUX_SCREENSHOT_DELAY))
    : 2200;
  log(`screenshot scheduled in ${delay}ms -> ${screenshotPath}`);
  screenshotTimer = setTimeout(async () => {
    const target = win;
    if (!target || target.isDestroyed()) {
      log('screenshot skipped: window is gone');
      if (!exitAfterMs) quitApp('screenshot-missing');
      return;
    }
    log('screenshot capture starting');
    try {
      const image = await Promise.race([
        target.webContents.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('capturePage timeout after 8000 ms')), 8000)),
      ]);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, image.toPNG());
      log(`screenshot saved ${screenshotPath}`);
    } catch (error) {
      log(`screenshot failed: ${error && error.message ? error.message : error}`);
    } finally {
      if (!exitAfterMs) setTimeout(() => quitApp('screenshot'), 200);
    }
  }, delay);
}

const trayActions = {
  toggleVisibility,
  showWindow,
  hideWindow,
  setMode: (nextMode) => setMode(nextMode),
  setOpacity: (value) => setOpacity(value),
  toggleClickThrough: () => setClickThrough(!clickThrough),
  quit: () => quitApp('tray'),
};

function createTray() {
  try {
    tray = createTrayController({ actions: trayActions });
    tray.update({ ...stateSnapshot(), bridgeUrl, demo });
  } catch (error) {
    log(`tray creation failed: ${error && error.message ? error.message : error}`);
  }
}

function refreshTray() {
  if (tray) tray.update({ ...stateSnapshot(), bridgeUrl, demo });
}

function senderIsCompanion(event) {
  return Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents);
}

function registerIpc() {
  // Synchronous config for preload (renderer module evaluation needs bridge URL
  // and token before its first async turn). Local IPC only; never logged.
  ipcMain.on('haloflux:get-config-sync', (event) => {
    event.returnValue = senderIsCompanion(event)
      ? {
          bridgeUrl,
          token: tokenInfo.token,
          tokenSource: tokenInfo.source,
          mode,
          clickThrough,
          opacity,
          demo,
          version: COMPANION_VERSION,
          platform: process.platform,
          settingsFile,
          renderer: 'electron',
        }
      : { bridgeUrl: '', token: '', demo: false, mode };
  });
  ipcMain.handle('haloflux:get-info', (event) => {
    if (!senderIsCompanion(event)) return null;
    return infoSnapshot();
  });
  ipcMain.handle('haloflux:get-state', (event) => {
    if (!senderIsCompanion(event)) return null;
    return stateSnapshot();
  });
  ipcMain.handle('haloflux:set-mode', (event, nextMode) => {
    if (!senderIsCompanion(event) || !MODES.includes(nextMode)) return stateSnapshot();
    return setMode(nextMode);
  });
  ipcMain.handle('haloflux:set-opacity', (event, value) => {
    if (!senderIsCompanion(event)) return stateSnapshot();
    return setOpacity(value);
  });
  ipcMain.handle('haloflux:set-click-through', (event, enabled) => {
    if (!senderIsCompanion(event)) return stateSnapshot();
    return setClickThrough(Boolean(enabled));
  });
  ipcMain.handle('haloflux:toggle-click-through', (event) => {
    if (!senderIsCompanion(event)) return stateSnapshot();
    return setClickThrough(!clickThrough);
  });
  ipcMain.handle('haloflux:show', (event) => {
    if (!senderIsCompanion(event)) return stateSnapshot();
    showWindow();
    return stateSnapshot();
  });
  ipcMain.handle('haloflux:hide', (event) => {
    if (!senderIsCompanion(event)) return stateSnapshot();
    hideWindow();
    return stateSnapshot();
  });
  ipcMain.handle('haloflux:quit', (event) => {
    if (!senderIsCompanion(event)) return false;
    quitApp('ipc');
    return true;
  });
}

function registerShortcuts() {
  const toggle = globalShortcut.register('Control+Alt+H', () => setClickThrough(!clickThrough));
  if (!toggle) log('global shortcut Control+Alt+H failed to register');
  // Ctrl+Alt+M is the contract shortcut; if another application owns it on this
  // machine we register a documented fallback instead of failing silently.
  let modeShortcut = 'Control+Alt+M';
  let cycle = globalShortcut.register(modeShortcut, () => cycleMode());
  if (!cycle) {
    modeShortcut = 'Control+Alt+Shift+M';
    cycle = globalShortcut.register(modeShortcut, () => cycleMode());
    if (cycle) log(`global shortcut Control+Alt+M unavailable; using ${modeShortcut} for mode cycling`);
  }
  if (!cycle) log('global shortcut for mode cycling failed to register (tray menu still works)');
}

function wireDisplayChanges() {
  const onChange = () => {
    if (!win || win.isDestroyed()) return;
    applyDisplayMetrics(win, { mode, zoomOverride: env.HALOFLUX_COMPANION_ZOOM });
    broadcastState();
  };
  screen.on('display-metrics-changed', onChange);
  screen.on('display-added', onChange);
  screen.on('display-removed', onChange);
}

function bootstrap() {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.haloflux.companion');

  registerIpc();
  wireDisplayChanges();
  createWindow();
  createTray();
  registerShortcuts();

  ipcMain.on('haloflux:preload-ready', (_event, payload) => {
    log(`preload ready ${payload && payload.version ? payload.version : ''}`.trim());
  });

  if (exitAfterMs > 0) {
    setTimeout(() => quitApp('selftest'), exitAfterMs);
  }

  app.on('second-instance', () => {
    showWindow();
  });
  app.on('activate', () => {
    showWindow();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('another HALOFLUX Companion instance is already running; exiting');
  app.exit(0);
} else {
  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[companion] startup failed:', error && error.stack ? error.stack : error);
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  // Tray application: keep running after the window is closed; the tray
  // "显示窗口" item recreates it.
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('child-process-gone', (_event, details) => {
  if (!details) return;
  log(`child process gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});
