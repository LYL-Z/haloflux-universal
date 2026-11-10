#!/usr/bin/env node
/**
 * Full-window replay recorder (P3.2-A evidence).
 *
 * Offscreen BrowserWindow renders the real companion renderer in REPLAY mode,
 * captures PNG frames at a fixed rate, then encodes them with ffmpeg. No desktop
 * capture is involved, so unrelated windows can never leak into the video.
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createReadStream, existsSync, statSync, mkdirSync, writeFileSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(process.env.HALOFLUX_REC_ROOT || '.');
const OUT = path.resolve(process.env.HALOFLUX_REC_OUT || 'replay.mp4');
const SECONDS = Math.max(2, Number(process.env.HALOFLUX_REC_SECONDS || '12'));
const FPS = Math.max(4, Math.min(30, Number(process.env.HALOFLUX_REC_FPS || '12')));
const SESSION = process.env.HALOFLUX_REC_SESSION || '';
const TOKEN = process.env.HALOFLUX_REC_TOKEN || '';
const BRIDGE = process.env.HALOFLUX_REC_BRIDGE || 'http://127.0.0.1:17817';
const TRACE = process.env.HALOFLUX_REC_TRACE === '1';
const FFMPEG = process.env.HALOFLUX_FFMPEG || '';
const FRAMES = path.join(path.dirname(OUT), `${path.basename(OUT, path.extname(OUT))}-frames`);

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

app.disableHardwareAcceleration();

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const query = new URLSearchParams({
    preset: 'agent-monitor', replay: SESSION, bridge: BRIDGE, token: TOKEN,
    ...(TRACE ? { trace: '1' } : {}),
  });
  const url = `http://127.0.0.1:${port}/apps/companion/renderer/index.html?${query}`;
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  await win.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  mkdirSync(FRAMES, { recursive: true });
  for (const file of readdirSync(FRAMES)) rmSync(path.join(FRAMES, file), { force: true });
  const total = SECONDS * FPS;
  for (let i = 0; i < total; i += 1) {
    // Drive the replay deterministically; do not depend on window timers.
    await win.webContents.executeJavaScript(`window.__halofluxReplaySeek && window.__halofluxReplaySeek(${Math.round(i * 1000)})`);
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(FRAMES, `frame-${String(i).padStart(5, '0')}.png`), image.toPNG());
    await new Promise((resolve) => setTimeout(resolve, Math.round(1000 / FPS)));
  }
  win.destroy();
  server.close();
  const ffmpeg = FFMPEG || 'ffmpeg';
  mkdirSync(path.dirname(OUT), { recursive: true });
  const args = ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'frame-%05d.png'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', OUT];
  const child = spawn(ffmpeg, args, { stdio: 'ignore', windowsHide: true });
  child.on('exit', (code) => {
    console.log(JSON.stringify({ ok: code === 0, out: OUT, frames: total, fps: FPS, code }));
    app.exit(code === 0 ? 0 : 1);
  });
});
setTimeout(() => app.exit(5), (SECONDS * 8 + 60) * 1000);
