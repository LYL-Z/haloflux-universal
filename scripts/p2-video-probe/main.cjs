#!/usr/bin/env node
/**
 * Probe a recorded WebM: duration, resolution, and three extracted frames.
 * Chromium decodes the file; no ffmpeg dependency. Both the page and the media
 * are served from the same loopback origin so the video element can load it.
 *
 * Env:
 *   HALOFLUX_VIDEO      absolute .webm path
 *   HALOFLUX_VIDEO_OUT  directory for frame PNGs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const video = process.env.HALOFLUX_VIDEO || '';
const outDir = path.resolve(process.env.HALOFLUX_VIDEO_OUT || '.');

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/player')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><body style="margin:0;background:#000"><video id="v" muted playsinline preload="auto" src="/recording.webm"></video></body>');
    return;
  }
  const stat = fs.statSync(video);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(match ? match[1] : 0);
    const end = match && match[2] ? Number(match[2]) : stat.size - 1;
    res.writeHead(206, {
      'content-type': 'video/webm',
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    fs.createReadStream(video, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': 'video/webm',
    'content-length': stat.size,
    'accept-ranges': 'bytes',
  });
  fs.createReadStream(video).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on('console-message', (_e, _l, message) => console.log('[player]', message));
  await win.loadURL(`http://127.0.0.1:${port}/player`);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v');
    const meta = await new Promise((resolve, reject) => {
      if (v.readyState >= 1) { resolve('already-loaded'); return; }
      const timer = setTimeout(() => reject(new Error('metadata timeout state=' + v.readyState + ' net=' + v.networkState + ' err=' + (v.error && v.error.code))), 20000);
      v.onloadedmetadata = () => { clearTimeout(timer); resolve('loadedmetadata'); };
      v.onerror = () => { clearTimeout(timer); reject(new Error('video error code=' + (v.error && v.error.code) + ' message=' + (v.error && v.error.message))); };
    });
    const frames = [];
    for (const t of [1, 10, 20]) {
      v.currentTime = Math.min(t, Math.max(0, (v.duration || 30) - 0.1));
      await new Promise((resolve) => { v.onseeked = resolve; setTimeout(resolve, 5000); });
      const c = document.createElement('canvas');
      c.width = v.videoWidth || 1600; c.height = v.videoHeight || 900;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#020204';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(v, 0, 0);
      frames.push({ t, data: c.toDataURL('image/png') });
    }
    return { meta, duration: v.duration, width: v.videoWidth, height: v.videoHeight, frames };
  })()`, true);
  fs.mkdirSync(outDir, { recursive: true });
  for (const frame of result.frames) {
    const b64 = frame.data.split(',')[1];
    fs.writeFileSync(path.join(outDir, `frame-${String(frame.t).padStart(2, '0')}s.png`), Buffer.from(b64, 'base64'));
  }
  fs.writeFileSync(path.join(outDir, 'video-probe.json'), JSON.stringify({ duration: result.duration, width: result.width, height: result.height, frames: result.frames.map((f) => f.t) }, null, 2));
  console.log(JSON.stringify({ duration: result.duration, width: result.width, height: result.height }));
  win.destroy();
  server.close();
  app.exit(0);
});

setTimeout(() => app.exit(4), 90000);
