#!/usr/bin/env node
/**
 * Chrome Performance Trace capture for P4.1-R3.
 *
 * Uses the DevTools protocol Tracing domain on a real visible Electron window.
 * The URL must point at the companion renderer with a fixed replay workload.
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } = require('node:fs');
const { gzipSync } = require('node:zlib');
const path = require('node:path');

const ROOT = path.resolve(process.env.HALOFLUX_TRACE_ROOT || '.');
const OUT = path.resolve(process.env.HALOFLUX_TRACE_OUT || 'trace.json.gz');
const META = process.env.HALOFLUX_TRACE_META ? path.resolve(process.env.HALOFLUX_TRACE_META) : '';
const SECONDS = Math.max(5, Number(process.env.HALOFLUX_TRACE_SECONDS || '15'));
const PAGE = process.env.HALOFLUX_TRACE_PAGE || 'apps/companion/renderer/index.html';
const QUERY = process.env.HALOFLUX_TRACE_QUERY || '';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = new BrowserWindow({
    width: 1536, height: 900, show: true, backgroundColor: '#020204',
    webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.focus();
  const url = `http://127.0.0.1:${port}/${PAGE}${QUERY ? `?${QUERY}` : ''}`;
  await win.loadURL(url);
  // Let replay finish paging and enter its 200 ms loop before tracing.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const state = await win.webContents.executeJavaScript(`(() => ({
    perf: window.__halofluxPerf || null,
    visibility: document.visibilityState,
    focus: document.hasFocus(),
    dpr: window.devicePixelRatio,
    size: [innerWidth, innerHeight],
    replay: window.__halofluxReplayPerf || null
  }))()`);
  if (!state.perf || !state.perf.events) {
    if (process.env.HALOFLUX_TRACE_REQUIRE_REPLAY !== '0') {
      console.error(JSON.stringify({ ok: false, error: 'replay not loaded', state }));
      app.exit(2);
      return;
    }
  }
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const chunks = [];
  let completeResolve;
  const complete = new Promise((resolve) => { completeResolve = resolve; });
  dbg.on('message', (_event, method, params) => {
    if (method === 'Tracing.dataCollected') chunks.push(...(params.value || []));
    if (method === 'Tracing.tracingComplete') completeResolve(params);
  });
  const categories = process.env.HALOFLUX_TRACE_CATEGORIES || [
    'devtools.timeline', 'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.picture',
    'disabled-by-default-devtools.timeline.layers', 'blink.user_timing',
    'cc', 'gpu', 'v8', 'disabled-by-default-v8.gc',
  ].join(',');
  await dbg.sendCommand('Tracing.start', {
    categories,
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  await dbg.sendCommand('Tracing.end');
  await complete;
  const finishedAt = Date.now();
  const trace = { traceEvents: chunks, metadata: { ...state, url, seconds: SECONDS, startedAt, finishedAt } };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, gzipSync(Buffer.from(JSON.stringify(trace))));
  if (META) {
    mkdirSync(path.dirname(META), { recursive: true });
    writeFileSync(META, JSON.stringify({ ...state, url, seconds: SECONDS, startedAt, finishedAt, events: chunks.length, out: OUT }, null, 2));
  }
  console.log(JSON.stringify({ ok: true, out: OUT, events: chunks.length, bytes: statSync(OUT).size, state }));
  try { dbg.detach(); } catch { /* ignore */ }
  win.destroy();
  server.close();
  app.exit(0);
});
setTimeout(() => { console.error(JSON.stringify({ ok: false, error: 'timeout' })); app.exit(5); }, (SECONDS + 30) * 1000);
