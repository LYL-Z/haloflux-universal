#!/usr/bin/env node
/**
 * Record the live renderer canvas to WebM for P2 motion evidence.
 *
 * Loads the page over loopback HTTP (ES modules need a real origin), then runs
 * MediaRecorder on the HALOFLUX canvas and saves the WebM through Chromium's
 * download pipeline. 30 s of 1600x900 VP9 is ~10-30 MB, so the file is kept
 * outside the repository; the report records its SHA256 and this reproduction
 * command.
 *
 * Env (no URL in argv, per this machine's Electron argv trap):
 *   HALOFLUX_REC_ROOT      repo root to serve
 *   HALOFLUX_REC_PATH      e.g. apps/companion/renderer/index.html?qa=1&mock=1&preset=agent-monitor&state=tool
 *   HALOFLUX_REC_OUT       absolute output .webm path
 *   HALOFLUX_REC_SECONDS   default 30
 *   HALOFLUX_REC_WIDTH / _HEIGHT  default 1600 / 900
 *   HALOFLUX_REC_WAIT      settle ms before recording, default 5000
 *   HALOFLUX_REC_SHOW=1    show the window (visible desktop) instead of hidden
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const root = path.resolve(process.env.HALOFLUX_REC_ROOT || '.');
const pagePath = process.env.HALOFLUX_REC_PATH || 'apps/companion/renderer/index.html?qa=1&mock=1&preset=agent-monitor&state=tool';
const out = path.resolve(process.env.HALOFLUX_REC_OUT || 'p2-recording.webm');
const seconds = Number(process.env.HALOFLUX_REC_SECONDS || '30');
const width = Number(process.env.HALOFLUX_REC_WIDTH || '1600');
const height = Number(process.env.HALOFLUX_REC_HEIGHT || '900');
const wait = Number(process.env.HALOFLUX_REC_WAIT || '5000');
const show = process.env.HALOFLUX_REC_SHOW === '1';

mkdirSync(path.dirname(out), { recursive: true });

const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

function recordScript(secs) {
  const selector = process.env.HALOFLUX_REC_SELECTOR || '#haloflux-canvas';
  return `(async () => {
    const canvas = document.querySelector(${JSON.stringify(selector)});
    if (!canvas) return { error: 'canvas missing' };
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
    const chunks = [];
    rec.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    const t0 = performance.now();
    rec.start(500);
    await new Promise((resolve) => setTimeout(resolve, ${Math.round(secs * 1000)}));
    rec.stop();
    await stopped;
    const elapsed = performance.now() - t0;
    const blob = new Blob(chunks, { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ${JSON.stringify(path.basename(out))};
    document.body.appendChild(a);
    a.click();
    return { mime, seconds: elapsed / 1000, bytes: blob.size, chunks: chunks.length };
  })()`;
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${pagePath.replace(/^\//, '')}`;
  console.log(`[p2-record] ${width}x${height} ${seconds}s ${url} -> ${out}`);
  await app.whenReady();
  const win = new BrowserWindow({
    width, height, show, frame: false, backgroundColor: '#020204',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.session.on('will-download', (_event, item) => {
    item.setSavePath(out);
    item.once('done', (_e, state) => {
      console.log(`[p2-record] download ${state} -> ${out}`);
      try {
        const buf = require('node:fs').readFileSync(out);
        writeFileSync(out + '.json', JSON.stringify({ bytes: buf.length, sha256: require('node:crypto').createHash('sha256').update(buf).digest('hex') }, null, 2));
      } catch (error) { console.error('[p2-record] hash failed', error.message); }
      server.close();
      app.exit(state === 'completed' ? 0 : 1);
    });
  });
  win.webContents.on('console-message', (_e, _l, message) => console.log('[page]', message));
  try { await win.loadURL(url); } catch (error) { console.error('[p2-record] load', error.message); }
  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, wait)));
  try {
    const result = await win.webContents.executeJavaScript(recordScript(seconds), true);
    console.log('[p2-record] result', JSON.stringify(result));
  } catch (error) {
    console.error('[p2-record] record failed', error.message);
    app.exit(2);
  }
});

setTimeout(() => { console.error('[p2-record] timeout'); app.exit(3); }, Math.max(150000, seconds * 1000 + 90000));
