/**
 * HALOFLUX companion preload — the only bridge between the sandboxed renderer
 * and the Electron main process (contextIsolation: true, nodeIntegration: false,
 * sandbox: true).
 *
 * Exposed API (`window.haloflux`, alias `window.halofluxCompanion`):
 *
 *   getInfo(): Promise<{
 *     bridgeUrl, token, tokenSource, mode, clickThrough, opacity, demo,
 *     visible, version, electron, chrome, node, platform, arch,
 *     settings: { preset, visual, companion }, display: { id, scaleFactor, bounds, workArea }
 *   }>
 *   getState(): Promise<{ mode, clickThrough, opacity, visible, bridgeUrl, demo, ... }>
 *   setMode('window'|'overlay'|'compact'): Promise<state>
 *   setOpacity(number 0.1..1): Promise<state>
 *   setClickThrough(boolean): Promise<state>
 *   toggleClickThrough(): Promise<state>
 *   show(): Promise<state>; hide(): Promise<state>; quit(): Promise<boolean>
 *   onStateChange(cb): unsubscribe
 *   onLifecycle(cb): unsubscribe          // cb('pause'|'resume')
 *   onPause(cb): unsubscribe
 *   onResume(cb): unsubscribe
 *   platform: NodeJS.Platform
 *
 * The renderer never gets ipcRenderer itself, and every channel payload is a
 * plain JSON object.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (error) {
      // Never let a renderer callback break the preload bridge.
      console.error('[haloflux preload] listener error', error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  version: '0.1.0',
  platform: process.platform,

  getInfo: () => ipcRenderer.invoke('haloflux:get-info'),
  getState: () => ipcRenderer.invoke('haloflux:get-state'),
  getBridgeInfo: () => ipcRenderer.invoke('haloflux:get-info'),

  setMode: (mode) => ipcRenderer.invoke('haloflux:set-mode', mode),
  setOpacity: (value) => ipcRenderer.invoke('haloflux:set-opacity', value),
  setClickThrough: (enabled) => ipcRenderer.invoke('haloflux:set-click-through', Boolean(enabled)),
  toggleClickThrough: () => ipcRenderer.invoke('haloflux:toggle-click-through'),

  show: () => ipcRenderer.invoke('haloflux:show'),
  hide: () => ipcRenderer.invoke('haloflux:hide'),
  quit: () => ipcRenderer.invoke('haloflux:quit'),

  onStateChange: (callback) => subscribe('haloflux:state', callback),
  onModeChange: (callback) => subscribe('haloflux:state', callback),
  onLifecycle: (callback) => subscribe('haloflux:lifecycle', callback),
  onPause: (callback) => subscribe('haloflux:lifecycle', (type) => {
    if (type === 'pause') callback();
  }),
  onResume: (callback) => subscribe('haloflux:lifecycle', (type) => {
    if (type === 'resume') callback();
  }),
};

// The renderer reads a synchronous config object during module evaluation
// (`window.halofluxConfig`), before any async IPC could resolve. sendSync is
// local-only (same process pair, no network) and every payload is plain JSON.
let syncConfig = {};
try {
  syncConfig = ipcRenderer.sendSync('haloflux:get-config-sync') || {};
} catch (error) {
  console.error('[haloflux preload] config sync failed', error);
}

try {
  contextBridge.exposeInMainWorld('haloflux', api);
  contextBridge.exposeInMainWorld('halofluxCompanion', api);
  contextBridge.exposeInMainWorld('halofluxConfig', Object.freeze({ ...syncConfig }));
  ipcRenderer.send('haloflux:preload-ready', { version: api.version });
} catch (error) {
  console.error('[haloflux preload] contextBridge failed', error);
}
