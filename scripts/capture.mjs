#!/usr/bin/env node
/**
 * HALOFLUX capture harness 鈥?Electron screenshots of every preset and agent
 * state (docs/architecture.md 搂11 "visual").
 *
 * Why a tiny local HTTP server: the renderer is an ES-module page; Chromium
 * refuses file:// module imports, so the page is served from 127.0.0.1 on an
 * OS-assigned port (no external network, no dependency).
 *
 * Why environment variables for Electron: on this machine the bundled Electron
 * 43.3.0 terminates before the main script runs when argv contains a file://
 * URL plus other arguments (lead-verified). scripts/render-app reads
 * HALOFLUX_RENDER_* env vars only, disables hardware acceleration, and captures
 * an offscreen BrowserWindow. `ELECTRON_RUN_AS_NODE` is removed from the child
 * env or Electron would run as plain Node.
 *
 * Renderer contract used here (requested from visual-dev, degrades gracefully):
 *   ?qa=1&preset=<name>&state=<state>&mock=1&multi=1
 *   window.__halofluxQA.getStats() -> { preset, state, fps, ... }
 *
 * Output: screenshots/preset-*.png, state-*.png, ui-overview.png,
 *         multi-agent.png (if supported) + screenshots/capture-report.json.
 * Exit 0 when the renderer is NOT_READY (script + report written), 1 when the
 * renderer exists but captures fail.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_DIR = path.join(ROOT, 'apps', 'companion', 'renderer');
const RENDERER_INDEX = path.join(RENDERER_DIR, 'index.html');
const RENDER_APP_DIR = path.join(ROOT, 'scripts', 'render-app');
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const REPORT = path.join(SHOTS_DIR, 'capture-report.json');
const ELECTRON = process.env.HALOFLUX_ELECTRON
  || path.join(os.homedir(), '.dsh', 'electron', 'electron.exe');

const PRESETS = ['original', 'minimal', 'sci-fi', 'focus', 'ambient', 'agent-monitor'];
const STATES = [
  'disconnected', 'connected', 'idle', 'running', 'tool',
  'output', 'waiting_approval', 'done', 'error', 'unknown',
];

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
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function writeReport(report) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/') pathname = '/apps/companion/renderer/index.html';
        const target = path.resolve(ROOT, `.${pathname}`);
        if (!target.startsWith(ROOT + path.sep) || !isFile(target)) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        });
        fs.createReadStream(target).pipe(res);
      } catch {
        res.writeHead(500);
        res.end('error');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runRender(url, out, { wait = 4200, width = 1600, height = 900 } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
    const env = {
      ...process.env,
      HALOFLUX_RENDER_URL: url,
      HALOFLUX_RENDER_OUT: out,
      HALOFLUX_RENDER_WAIT: String(wait),
      HALOFLUX_RENDER_WIDTH: String(width),
      HALOFLUX_RENDER_HEIGHT: String(height),
    };
    // Deterministic trap: inherited env normally forces Electron into Node mode.
    delete env.ELECTRON_RUN_AS_NODE;
    const started = Date.now();
    const child = spawn(ELECTRON, [RENDER_APP_DIR], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, Math.max(30000, wait + 20000));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn failed: ${error.message}`, stdout, stderr, elapsedMs: Date.now() - started });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const exists = isFile(out);
      const size = exists ? fs.statSync(out).size : 0;
      resolve({
        ok: code === 0 && exists && size > 0,
        code,
        bytes: size,
        elapsedMs: Date.now() - started,
        stdout: stdout.trim().slice(0, 500),
        stderr: stderr.trim().slice(0, 1000),
        reason: code !== 0
          ? `electron exited ${code}`
          : !exists
            ? 'output file missing'
            : size === 0
              ? 'output file empty'
              : undefined,
      });
    });
  });
}

async function main() {
  const baseReport = {
    generatedAt: new Date().toISOString(),
    machine: { platform: process.platform, release: process.version },
    electron: ELECTRON,
    renderer: path.relative(ROOT, RENDERER_INDEX),
    presets: PRESETS,
    states: STATES,
    shots: [],
    status: 'UNKNOWN',
  };

  if (!isFile(RENDERER_INDEX) || !isFile(path.join(RENDERER_DIR, 'app.js'))) {
    baseReport.status = 'NOT_READY';
    baseReport.reason = `NOT_READY: renderer entry missing (${!isFile(RENDERER_INDEX) ? 'index.html' : 'app.js'} not found); script is ready and can be re-run once visual-dev lands the UI`;
    writeReport(baseReport);
    console.log(JSON.stringify({ status: baseReport.status, reason: baseReport.reason, report: path.relative(ROOT, REPORT) }, null, 2));
    return 0;
  }
  if (!isFile(path.join(RENDER_APP_DIR, 'main.cjs'))) {
    baseReport.status = 'NOT_READY';
    baseReport.reason = 'NOT_READY: scripts/render-app/main.cjs missing';
    writeReport(baseReport);
    console.log(JSON.stringify({ status: baseReport.status, reason: baseReport.reason }, null, 2));
    return 0;
  }
  if (!isFile(ELECTRON)) {
    baseReport.status = 'BLOCKED';
    baseReport.reason = `BLOCKED: Electron not found at ${ELECTRON} (set HALOFLUX_ELECTRON)`;
    writeReport(baseReport);
    console.log(JSON.stringify({ status: baseReport.status, reason: baseReport.reason }, null, 2));
    return 0;
  }

  const staticServer = await startStaticServer();
  const jobs = [];
  jobs.push({
    kind: 'overview',
    name: 'ui-overview',
    url: `${staticServer.origin}/apps/companion/renderer/index.html?qa=1`,
    out: path.join(SHOTS_DIR, 'ui-overview.png'),
  });
  for (const preset of PRESETS) {
    jobs.push({
      kind: 'preset',
      name: preset,
      url: `${staticServer.origin}/apps/companion/renderer/index.html?qa=1&preset=${encodeURIComponent(preset)}&mock=1`,
      out: path.join(SHOTS_DIR, `preset-${preset}.png`),
    });
  }
  for (const state of STATES) {
    jobs.push({
      kind: 'state',
      name: state,
      url: `${staticServer.origin}/apps/companion/renderer/index.html?qa=1&state=${encodeURIComponent(state)}&mock=1`,
      out: path.join(SHOTS_DIR, `state-${state}.png`),
    });
  }
  jobs.push({
    kind: 'multi',
    name: 'multi-agent',
    url: `${staticServer.origin}/apps/companion/renderer/index.html?qa=1&multi=1&mock=1`,
    out: path.join(SHOTS_DIR, 'multi-agent.png'),
    optional: true,
  });

  try {
    for (const job of jobs) {
      const result = await runRender(job.url, job.out);
      baseReport.shots.push({
        kind: job.kind,
        name: job.name,
        file: path.relative(ROOT, job.out),
        url: job.url.replace(staticServer.origin, 'http://127.0.0.1:<port>'),
        optional: Boolean(job.optional),
        ...result,
      });
      console.log(`[capture] ${job.kind}/${job.name}: ${result.ok ? 'OK' : 'FAIL'} ${result.bytes ?? 0} bytes ${result.elapsedMs}ms`);
    }
  } finally {
    await staticServer.close();
  }

  const required = baseReport.shots.filter((shot) => !shot.optional);
  const failed = required.filter((shot) => !shot.ok);
  baseReport.status = failed.length === 0 ? 'PASS' : 'FAIL';
  baseReport.reason = failed.length === 0
    ? `${required.length} required screenshots captured`
    : `${failed.length}/${required.length} captures failed: ${failed.map((shot) => shot.name).join(', ')}`;
  writeReport(baseReport);
  console.log(JSON.stringify({
    status: baseReport.status,
    reason: baseReport.reason,
    shots: baseReport.shots.length,
    report: path.relative(ROOT, REPORT),
  }, null, 2));
  return failed.length === 0 ? 0 : 1;
}

const exitCode = await main();
process.exit(exitCode);


