#!/usr/bin/env node
/**
 * P2 one-shot renderer capture.
 *
 * Serves a repository snapshot over loopback HTTP (ES modules need a real HTTP
 * origin), then asks the proven scripts/render-app Electron shell to capture it.
 * Configuration travels via environment/flags of THIS process only; Electron
 * itself receives no file:// URL in argv (machine-level Electron argv trap).
 *
 *   node scripts/p2-capture.mjs --root . --path "apps/companion/renderer/index.html?qa=1&mock=1&preset=agent-monitor&state=tool" \
 *        --out screenshots/p2/after-1600x900.png --width 1600 --height 900
 *
 *   node scripts/p2-capture.mjs --root . --path "upstream/haloflux/lab.html" \
 *        --out screenshots/p2/upstream-1600x900.png --width 1600 --height 900 --wait 6000
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER_APP = path.join(ROOT, 'scripts', 'render-app');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg('root', ROOT));
const urlPath = arg('path', 'apps/companion/renderer/index.html?qa=1&mock=1&preset=agent-monitor');
const out = path.resolve(arg('out', 'screenshots/p2/capture.png'));
const width = Number(arg('width', '1600'));
const height = Number(arg('height', '900'));
const wait = Number(arg('wait', '5000'));
const dpr = Number(arg('dpr', '1'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${urlPath.replace(/^\//, '')}`;
  mkdirSync(path.dirname(out), { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.HALOFLUX_RENDER_URL = url;
  env.HALOFLUX_RENDER_OUT = out;
  env.HALOFLUX_RENDER_WAIT = String(wait);
  env.HALOFLUX_RENDER_WIDTH = String(width);
  env.HALOFLUX_RENDER_HEIGHT = String(height);
  env.HALOFLUX_RENDER_DPR = String(dpr);
  console.error(`[p2-capture] ${width}x${height} ${url.replace(/([?&](token|api[_-]?key)=)[^&]+/gi, '$1***')} -> ${out}`);
  const child = spawn(process.env.HALOFLUX_ELECTRON || path.join(os.homedir(), '.dsh', 'electron', 'electron.exe'), [RENDER_APP], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env,
  });
  const done = (code) => {
    server.close();
    process.exit(code ?? 0);
  };
  child.on('exit', done);
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, Math.max(60000, wait + 45000)).unref();
});
