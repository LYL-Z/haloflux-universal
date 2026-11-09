#!/usr/bin/env node
/**
 * Headless page renderer used to capture evidence screenshots with the Electron
 * build that ships inside DeepSeek Harness (43.3.0). No download, no server.
 *
 * Configuration is read from environment variables, NOT command-line arguments:
 * on this machine a `file://` URL in argv together with hardware acceleration
 * disabled terminates Electron before the main script runs (exit -1, no log).
 * Environment variables avoid that Chromium argv path entirely.
 *
 *   HALOFLUX_RENDER_URL         required, e.g. file:///D:/HALOFLUX/apps/companion/renderer/index.html?demo=1
 *   HALOFLUX_RENDER_OUT         required, absolute PNG path
 *   HALOFLUX_RENDER_WAIT        ms to wait after load (default 4000)
 *   HALOFLUX_RENDER_WIDTH       default 1600
 *   HALOFLUX_RENDER_HEIGHT      default 900
 *   HALOFLUX_RENDER_DPR         device scale factor, 0 = leave default
 *   HALOFLUX_RENDER_SCROLL      vertical scroll before capture
 *   HALOFLUX_RENDER_TRANSPARENT 1 = transparent window
 *
 * Exit 0 on success, prints absolute output path. Diagnostics land in
 * scripts/render-app/last-run.log because crashes produce no stdout.
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const logPath = path.join(__dirname, 'last-run.log');
try { writeFileSync(logPath, `boot ${new Date().toISOString()}\n`); } catch { /* ignore */ }
const log = (line) => { try { appendFileSync(logPath, line + '\n'); } catch { /* ignore */ } };

const env = process.env;
const url = env.HALOFLUX_RENDER_URL || '';
const out = env.HALOFLUX_RENDER_OUT || '';
const wait = Number(env.HALOFLUX_RENDER_WAIT || '4000');
const width = Number(env.HALOFLUX_RENDER_WIDTH || '1600');
const height = Number(env.HALOFLUX_RENDER_HEIGHT || '900');
const dpr = Number(env.HALOFLUX_RENDER_DPR || '0');
const scroll = Number(env.HALOFLUX_RENDER_SCROLL || '0');
const transparent = env.HALOFLUX_RENDER_TRANSPARENT === '1';

if (!url || !out) {
  console.error('missing HALOFLUX_RENDER_URL / HALOFLUX_RENDER_OUT');
  app.exit(2);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
if (dpr > 0) app.commandLine.appendSwitch('force-device-scale-factor', String(dpr));

app.whenReady().then(async () => {
  log('ready');
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    transparent,
    frame: false,
    backgroundColor: transparent ? '#00000000' : '#0a0b0f',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  log('window');
  win.webContents.on('console-message', (_e, level, message) => log(`[page ${level}] ${message}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`load failed ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, details) => log('render-gone ' + JSON.stringify(details)));
  try {
    await win.loadURL(url);
    log('loaded ' + url);
  } catch (err) {
    log('loaderr ' + (err && err.message ? err.message : err));
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(300, wait)));
  if (scroll > 0) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${Math.round(scroll)});`, true).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  log('capturing');
  const image = await win.webContents.capturePage();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, image.toPNG());
  log('captured ' + out + ' ' + image.getSize().width + 'x' + image.getSize().height);
  console.log(out);
  win.destroy();
  app.exit(0);
});

setTimeout(() => {
  log('timeout');
  app.exit(3);
}, Math.max(20000, wait + 15000));
