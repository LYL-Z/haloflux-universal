#!/usr/bin/env node
/** 30-minute soak: replay 2500 at 1x, sample JS heap + process working set. */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(process.env.HALOFLUX_SOAK_ROOT || '.');
const OUT = path.resolve(process.env.HALOFLUX_SOAK_OUT || 'soak.json');
const SECONDS = Number(process.env.HALOFLUX_SOAK_SECONDS || 1800);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = new BrowserWindow({ width: 1536, height: 900, show: true, backgroundColor: '#020204', webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.setMenuBarVisibility(false);
  await win.loadURL(`http://127.0.0.1:${port}/apps/companion/renderer/index.html?${process.env.HALOFLUX_SOAK_QUERY || ''}`);
  const samples = [];
  let frames = 0;
  let started = performance.now();
  setInterval(async () => {
    try {
      const perf = await win.webContents.executeJavaScript(`({ heap: performance.memory ? performance.memory.usedJSHeapSize : null, now: performance.now(), perf: window.__halofluxPerf || null })`);
      const metrics = app.getAppMetrics().map((m) => ({ type: m.type, workingSetMb: Math.round((m.memory?.workingSetSize || 0) / 1024) }));
      samples.push({ at: new Date().toISOString(), elapsedSec: Math.round((performance.now() - started) / 1000), heap: perf.heap, fpsFrames: perf.perf?.frames?.length || 0, metrics });
      frames = perf.perf?.frames?.length || 0;
    } catch (error) { samples.push({ at: new Date().toISOString(), error: String(error) }); }
  }, 30_000);
  setTimeout(() => {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ seconds: SECONDS, frames, samples }, null, 2));
    console.log(JSON.stringify({ ok: true, out: OUT, samples: samples.length }));
    win.destroy(); server.close(); app.exit(0);
  }, SECONDS * 1000);
});
