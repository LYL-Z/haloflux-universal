#!/usr/bin/env node
/**
 * P2.2 visible-window FPS / frame-time probe (GPU path, no software fallback).
 *
 * Serves the renderer over loopback, opens a real window (not hidden), samples
 * requestAnimationFrame for N seconds, then reports fps mean/min/max, frame-time
 * mean/p95/max and JS heap. Results are written as JSON for the P2.2 report.
 *
 * Env:
 *   HALOFLUX_FPS_OUT      output JSON path
 *   HALOFLUX_FPS_SECONDS  sample seconds (default 12)
 *   HALOFLUX_FPS_MODE     window | overlay | compact (default window)
 *   HALOFLUX_FPS_WIDTH / _HEIGHT
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.env.HALOFLUX_FPS_ROOT || '.');
const OUT = path.resolve(process.env.HALOFLUX_FPS_OUT || 'fps.json');
const SECONDS = Number(process.env.HALOFLUX_FPS_SECONDS || '12');
const MODE = process.env.HALOFLUX_FPS_MODE || 'window';
const WIDTH = Number(process.env.HALOFLUX_FPS_WIDTH || '1600');
const HEIGHT = Number(process.env.HALOFLUX_FPS_HEIGHT || '900');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const pagePath = process.env.HALOFLUX_FPS_PATH || 'apps/companion/renderer/index.html?qa=1&mock=1&preset=agent-monitor&state=tool';
  const url = `http://127.0.0.1:${port}/${pagePath}`;
  await app.whenReady();
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT,
    show: MODE !== 'compact',
    frame: false,
    backgroundColor: '#020204',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (MODE !== 'window') win.setAlwaysOnTop(true);
  if (MODE === 'compact') win.setContentSize(320, 320);
  win.webContents.on('console-message', (_e, _l, message) => console.log('[page]', message));
  await win.loadURL(url);
  win.webContents.setZoomFactor(Number(process.env.HALOFLUX_FPS_ZOOM) || 1);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (process.env.HALOFLUX_FPS_SHOT) {
    const shot = path.resolve(process.env.HALOFLUX_FPS_SHOT);
    mkdirSync(path.dirname(shot), { recursive: true });
    writeFileSync(shot, (await win.capturePage()).toPNG());
  }
  const sample = await win.webContents.executeJavaScript(`(async () => {
    const frames = [];
    let last = performance.now();
    const start = last;
    await new Promise((resolve) => {
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (now - start >= ${Math.round(SECONDS * 1000)}) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsed = (last - start) / 1000;
    const sorted = [...frames].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
    const p50 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] || 0;
    const sum = frames.reduce((acc, value) => acc + value, 0);
    const mean = frames.length ? sum / frames.length : 0;
    const memory = performance.memory ? performance.memory.usedJSHeapSize : null;
    return {
      mode: ${JSON.stringify(MODE)},
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
      durationSeconds: elapsed,
      frames: frames.length,
      fps: frames.length / elapsed,
      frameMsMean: mean,
      frameMsP50: p50,
      frameMsP95: p95,
      frameMsMax: sorted[sorted.length - 1] || 0,
      frameMsMin: sorted[0] || 0,
      heapUsedBytes: memory,
    };
  })()`, true);
  mkdirSync(path.dirname(OUT), { recursive: true });
  try {
    sample.pagePerf = await win.webContents.executeJavaScript('window.__halofluxPerf || null');
  } catch { /* optional */ }
  if (process.env.HALOFLUX_FPS_INTERACTION === '1') {
    try {
      sample.interaction = await win.webContents.executeJavaScript(`(async () => {
        const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const traceButton = document.getElementById('btn-trace');
        const dag = document.getElementById('trace-tab-dag');
        const waterfall = document.getElementById('trace-tab-waterfall');
        if (!traceButton) return { error: 'no trace button' };
        if (traceButton.getAttribute('aria-expanded') !== 'true') traceButton.click();
        await waitFrame();
        const values = [];
        for (let i = 0; i < 30; i += 1) {
          const target = i % 2 ? waterfall : dag;
          const start = performance.now();
          target?.click();
          await waitFrame();
          values.push(performance.now() - start);
        }
        values.sort((a, b) => a - b);
        const at = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
        return { samples: values.length, p50: at(0.5), p95: at(0.95), max: values[values.length - 1], values };
      })()`);
    } catch (error) {
      sample.interaction = { error: String(error && error.message ? error.message : error) };
    }
  }
  try {
    sample.appMetrics = app.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      cpuPercent: metric.cpu?.percentCPUUsage ?? null,
      workingSetMb: metric.memory?.workingSetSize ? Math.round(metric.memory.workingSetSize / 1024) : null,
    }));
  } catch { /* metrics are optional */ }
  writeFileSync(OUT, JSON.stringify(sample, null, 2));
  console.log(JSON.stringify(sample));
  win.destroy();
  server.close();
  app.exit(0);
});
setTimeout(() => app.exit(5), 90000);
