#!/usr/bin/env node
/**
 * Privacy-safe window recorder for P4.1.
 *
 * Renders the real companion page in an Electron window, captures that window
 * through desktopCapturer (window source only, never the desktop), records with
 * MediaRecorder at normal frame rate, and posts the WebM back to a local sink.
 */
const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.env.HALOFLUX_REC_ROOT || '.');
const OUT = path.resolve(process.env.HALOFLUX_REC_OUT || 'window.webm');
const SECONDS = Math.max(2, Number(process.env.HALOFLUX_REC_SECONDS || '30'));
const SESSION = process.env.HALOFLUX_REC_SESSION || '';
const TOKEN = process.env.HALOFLUX_REC_TOKEN || '';
const BRIDGE = process.env.HALOFLUX_REC_BRIDGE || 'http://127.0.0.1:17817';
const TRACE = process.env.HALOFLUX_REC_TRACE === '1';
const START_REPLAY = process.env.HALOFLUX_REC_START_REPLAY === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

let savedResolve;
const saved = new Promise((resolve) => { savedResolve = resolve; });

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/save') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, buffer);
      savedResolve({ bytes: buffer.length });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, bytes: buffer.length }));
    });
    return;
  }
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

// Hardware acceleration stays enabled unless explicitly requested: window
// capture reaches 24-31 fps on this machine with GPU compositing, while
// software rendering caps the page at ~5 fps.
if (process.env.HALOFLUX_REC_SOFTWARE === '1') app.disableHardwareAcceleration();

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  await app.whenReady();
  const query = new URLSearchParams({
    preset: 'agent-monitor', bridge: BRIDGE, token: TOKEN,
    ...(SESSION && START_REPLAY ? { replay: SESSION } : {}), ...(TRACE ? { trace: '1' } : {}),
  });
  const win = new BrowserWindow({
    width: 1600, height: 900, show: true, backgroundColor: '#020204',
    webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  await win.loadURL(`http://127.0.0.1:${port}/apps/companion/renderer/index.html?${query}`);
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((item) => item.name.includes('HALOFLUX'));
  if (!source) {
    console.error(JSON.stringify({ ok: false, error: 'window source not found', sources: sources.map((s) => s.name) }));
    app.exit(2);
    return;
  }
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: source });
  }, { useSystemPicker: false });

  const script = `(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    const done = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    setTimeout(() => { document.getElementById('btn-trace')?.click(); }, 7000);
    setTimeout(() => { window.__halofluxEnterReplay?.(${JSON.stringify(SESSION)}); }, 13000);
    setTimeout(() => { window.__halofluxExitReplay?.(); }, 25000);
    await new Promise((resolve) => setTimeout(resolve, ${SECONDS * 1000}));
    recorder.stop();
    await done;
    for (const track of stream.getTracks()) track.stop();
    const blob = new Blob(chunks, { type: mime });
    const response = await fetch('http://127.0.0.1:${port}/save', { method: 'POST', body: blob });
    return { ok: response.ok, bytes: blob.size, mime };
  })()`;
  let result;
  try {
    result = await win.webContents.executeJavaScript(script, true);
  } catch (error) {
    result = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  const savedResult = await Promise.race([saved, new Promise((resolve) => setTimeout(() => resolve({ bytes: 0 }), 10000))]);
  console.log(JSON.stringify({ ...result, ...savedResult, out: OUT }));
  win.destroy();
  server.close();
  app.exit(result && result.ok && savedResult.bytes > 0 ? 0 : 1);
});
setTimeout(() => app.exit(5), (SECONDS + 40) * 1000);
