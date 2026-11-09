#!/usr/bin/env node
/**
 * Capture exactly one renderer state per Electron process.
 *
 * Long-lived hidden Electron windows on this machine can crash after ~1 minute
 * of software-rendered animation and can serve a stale DOM compositor frame
 * after rapid in-page state changes. A fresh process per evidence shot is boring
 * but reliable: the query string pins preset/state before the first paint.
 *
 * Env (no argv — see scripts/render-app for the Electron file URL argv bug):
 *   HALOFLUX_CAPTURE_URL   full renderer URL, e.g.
 *                          file:///D:/HALOFLUX/apps/companion/renderer/index.html?qa=1&mock=1&multi=1&preset=agent-monitor&state=tool
 *   HALOFLUX_CAPTURE_OUT   absolute PNG path
 *   HALOFLUX_CAPTURE_STATS optional JSON path (token is redacted before writing)
 *   HALOFLUX_CAPTURE_WAIT  settle ms (default 4200)
 *   HALOFLUX_CAPTURE_WIDTH / _HEIGHT  default 1600 / 900 (use 320 / 320 for compact)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.HALOFLUX_CAPTURE_URL || '';
const out = process.env.HALOFLUX_CAPTURE_OUT || '';
const wait = Number(process.env.HALOFLUX_CAPTURE_WAIT || '4200');
const statsPath = process.env.HALOFLUX_CAPTURE_STATS || '';
const width = Number(process.env.HALOFLUX_CAPTURE_WIDTH || '1600');
const height = Number(process.env.HALOFLUX_CAPTURE_HEIGHT || '900');

if (!url || !out) {
  console.error('missing HALOFLUX_CAPTURE_URL / HALOFLUX_CAPTURE_OUT');
  app.exit(2);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#06080b',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[page]', message);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('render-process-gone', JSON.stringify(details));
  });
  try {
    await win.loadURL(url);
    await sleep(wait);
    const stats = await win.webContents.executeJavaScript(
      '(window.__halofluxQA && window.__halofluxQA.getStats) ? window.__halofluxQA.getStats() : null',
      true,
    ).catch(() => null);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    const size = image.getSize();
    // Never write a bridge token into evidence logs, even though the capture
    // URL carries it for the SSE handshake.
    const safeUrl = String(url).replace(/([?&]token=)[^&]*/i, '$1***');
    const record = { url: safeUrl, out, size, stats };
    if (statsPath) {
      fs.mkdirSync(path.dirname(statsPath), { recursive: true });
      fs.writeFileSync(statsPath, JSON.stringify(record, null, 2));
    }
    console.log(JSON.stringify(record));
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error('capture-error', error && error.message ? error.message : String(error));
    app.exit(1);
  }
});

setTimeout(() => {
  console.error('capture timeout');
  app.exit(3);
}, 60000);
