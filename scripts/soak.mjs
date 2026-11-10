#!/usr/bin/env node
/**
 * HALOFLUX soak harness (docs/architecture.md 搂11 "soak").
 *
 *   node scripts/soak.mjs --minutes 5 [--events-per-second 4] [--out file]
 *                         [--no-renderer] [--width 1600] [--height 900]
 *
 * What is measured, and how (never estimated):
 *  - bridge RSS + cumulative CPU, sampled every 5 s via PowerShell Get-Process
 *    on the spawned bridge PID; CPU% = delta(cpu seconds) / interval / cores;
 *  - bridge eventCount/sessions read from GET /v1/state at each sample;
 *  - renderer page fps / JS heap / renderer CPU, from the offscreen Electron
 *    window: fps is counted with a requestAnimationFrame probe injected by this
 *    script, heap via performance.memory, CPU via app.getAppMetrics();
 *  - events pushed continuously through the real POST /v1/events API.
 *
 * Renderer mode: this same file is the Electron main script (spawned with the
 * bundled electron.exe). URL/port/token are passed in the environment, never in
 * argv: on this machine Electron 43.3.0 terminates before main when argv carries
 * a file:// URL. ELECTRON_RUN_AS_NODE is deleted from the child env. Hardware
 * acceleration is disabled (the bundled Electron crashes otherwise).
 *
 * Output: tests/evidence/soak-<utc>.json plus a printed summary table.
 * If the bridge is missing the script writes a NOT_READY report and exits 0.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_ENTRY = path.join(ROOT, 'packages', 'event-bridge', 'src', 'server.mjs');
const SCHEMA_ENTRY = path.join(ROOT, 'packages', 'event-schema', 'dist', 'index.js');
const RENDERER_DIR = path.join(ROOT, 'apps', 'companion', 'renderer');
const RENDERER_INDEX = path.join(RENDERER_DIR, 'index.html');
const EVIDENCE_DIR = path.join(ROOT, 'tests', 'evidence');
const ELECTRON = process.env.HALOFLUX_ELECTRON || path.join(os.homedir(), '.dsh', 'electron', 'electron.exe');
const IS_ELECTRON = Boolean(process.versions.electron);

function parseArgs(argv) {
  const get = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
  };
  const minutes = Math.max(0.05, Number(get('minutes', '5')) || 5);
  return {
    minutes,
    eventsPerSecond: Math.max(1, Number(get('events-per-second', '4')) || 4),
    out: get('out', ''),
    renderer: !argv.includes('--no-renderer'),
    width: Number(get('width', '1600')) || 1600,
    height: Number(get('height', '900')) || 900,
  };
}

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function machineInfo() {
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: os.cpus()?.[0]?.model ?? 'unknown',
    cores: os.cpus()?.length ?? 0,
    totalMemBytes: os.totalmem(),
    node: process.version,
    electron: process.versions.electron ?? null,
  };
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
  }[ext] ?? 'application/octet-stream';
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/') pathname = '/apps/companion/renderer/index.html';
        const target = path.resolve(ROOT, `.${pathname}`);
        if (!target.startsWith(ROOT + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': mimeFor(target), 'cache-control': 'no-store' });
        fs.createReadStream(target).pipe(res);
      } catch {
        res.writeHead(500);
        res.end('error');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function freePort() {
  for (let i = 0; i < 60; i += 1) {
    const port = 17910 + Math.floor(Math.random() * 90);
    if (await portFree(port)) return port;
  }
  throw new Error('no free port');
}

function tail(text, max = 3000) {
  return text.length > max ? text.slice(-max) : text;
}

function postJson(base, token, pathname, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const url = new URL(pathname, base);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ status: 0, text: error.message }));
    req.end(payload);
  });
}

function getJson(base, token, pathname, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const url = new URL(pathname, base);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ status: 0, text: error.message }));
    req.end();
  });
}

function sampleProcessPowerShell(pid) {
  return new Promise((resolve) => {
    const script = [
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      'if ($p) {',
      '  [pscustomobject]@{ rssBytes = [int64]$p.WorkingSet64; cpuSeconds = [double]$p.CPU } | ConvertTo-Json -Compress',
      '}',
    ].join('\n');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('exit', () => {
      try {
        const data = JSON.parse(out.trim());
        resolve({
          rssBytes: Number(data.rssBytes) || 0,
          cpuSeconds: Number(data.cpuSeconds) || 0,
        });
      } catch {
        resolve({ rssBytes: 0, cpuSeconds: 0 });
      }
    });
    child.on('error', () => resolve({ rssBytes: 0, cpuSeconds: 0 }));
  });
}

async function startBridge(port, home, token) {
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HALOFLUX_BRIDGE_PORT: String(port),
      HALOFLUX_HOME: home,
      HALOFLUX_TOKEN: token,
      HALOFLUX_LOG_LEVEL: 'error',
      NO_COLOR: '1',
    },
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
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`bridge exited ${child.exitCode}: ${tail(stderr)}`);
    const res = await getJson(base, token, '/v1/health', 800);
    if (res.status === 200) return { child, base, port, stdout: () => stdout, stderr: () => stderr };
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  throw new Error(`bridge did not become healthy: ${tail(stderr)}`);
}

async function stopBridge(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        handle.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 4000);
    handle.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      handle.child.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/** Deterministic event stream: 12 simulated sessions rotate through the loop. */
function createEventFactory() {
  let schema;
  const ready = import(pathToFileURL(SCHEMA_ENTRY).href).then((module) => {
    schema = module;
  });
  return {
    async init() {
      await ready;
    },
    next(index) {
      const hosts = ['codex', 'claude-code', 'cursor', 'trae', 'workbuddy', 'deepseek-harness'];
      const host = hosts[index % hosts.length];
      const sessionId = `soak-${host}-${index % 12}`;
      const cycle = ['session.start', 'task.received', 'run.start', 'tool.start', 'tool.end', 'run.end'];
      const eventType = cycle[Math.floor(index / 12) % cycle.length];
      const metadata = {};
      if (eventType === 'tool.start' || eventType === 'tool.end') metadata.toolName = 'Bash';
      if (eventType === 'task.received') metadata.projectName = 'haloflux-soak';
      if (eventType === 'run.end') metadata.durationMs = 250;
      return schema.createEvent({
        host,
        sessionId,
        eventType,
        hostVersion: 'soak-1.0',
        timestamp: Date.now(),
        metadata,
      });
    },
  };
}

/* ------------------------------------------------------------------ Electron */

async function electronMain() {
  const minutes = Math.max(0.05, Number(process.env.HALOFLUX_SOAK_MINUTES || '5'));
  const url = process.env.HALOFLUX_SOAK_URL;
  const out = process.env.HALOFLUX_SOAK_RENDERER_OUT;
  const width = Number(process.env.HALOFLUX_SOAK_WIDTH || '1600');
  const height = Number(process.env.HALOFLUX_SOAK_HEIGHT || '900');
  const { app, BrowserWindow } = await import('electron');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('no-sandbox');

  const samples = [];
  const startedAt = Date.now();
  const results = { status: 'FAIL', url: url?.replace(/token=[^&]+/, 'token=[redacted]'), samples };

  await app.whenReady();
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#0a0b0f',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    await win.loadURL(url);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await win.webContents.executeJavaScript(
      'window.__soakFrames = 0; (function soakTick(){ window.__soakFrames += 1; requestAnimationFrame(soakTick); })(); true;',
      true,
    );
    const probe = async () => {
      const at = Date.now();
      let frames = -1;
      let heapUsed = null;
      let qa = null;
      try {
        const raw = await win.webContents.executeJavaScript(
          'JSON.stringify({ frames: window.__soakFrames, heap: performance.memory ? performance.memory.usedJSHeapSize : null, qa: window.__halofluxQA && window.__halofluxQA.getStats ? window.__halofluxQA.getStats() : null })',
          true,
        );
        const parsed = JSON.parse(raw);
        frames = parsed.frames;
        heapUsed = parsed.heap;
        qa = parsed.qa;
      } catch {
        /* page gone */
      }
      const metrics = app.getAppMetrics();
      const rendererMetric = metrics.find((item) => /tab|renderer/i.test(String(item.type)));
      return {
        at,
        elapsedMs: at - startedAt,
        frames,
        heapUsedBytes: heapUsed,
        rendererCpuPercent: rendererMetric?.cpu?.percentCPUUsage ?? null,
        qaFps: qa?.fps ?? null,
        preset: qa?.preset ?? null,
        state: qa?.state ?? null,
      };
    };
    const intervalMs = 2000;
    let previous = await probe();
    samples.push({ ...previous, fps: null });
    while (Date.now() - startedAt < minutes * 60 * 1000) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const current = await probe();
      const seconds = (current.at - previous.at) / 1000;
      const frames = current.frames - previous.frames;
      current.fps = seconds > 0 && frames >= 0 ? Number((frames / seconds).toFixed(2)) : null;
      samples.push(current);
      previous = current;
    }
    results.status = 'PASS';
  } catch (error) {
    results.error = error?.message ?? String(error);
    results.status = 'FAIL';
  } finally {
    results.completedAt = new Date().toISOString();
    results.durationMs = Date.now() - startedAt;
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    }
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
    app.exit(0);
  }
}

/* ---------------------------------------------------------------- Node parent */

async function runElectronRenderer({ port, bridgeUrl, token, minutes, width, height, out }) {
  const staticServer = await startStaticServer();
  const rendererOut = path.join(path.dirname(out), `soak-renderer-${utcStamp()}.json`);
  const query = new URLSearchParams({ qa: '1', mock: '1', bridge: bridgeUrl, token });
  const url = `${staticServer.origin}/apps/companion/renderer/index.html?${query.toString()}`;
  const env = {
    ...process.env,
    HALOFLUX_SOAK_URL: url,
    HALOFLUX_SOAK_RENDERER_OUT: rendererOut,
    HALOFLUX_SOAK_MINUTES: String(minutes),
    HALOFLUX_SOAK_WIDTH: String(width),
    HALOFLUX_SOAK_HEIGHT: String(height),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Electron 43 on this machine must be started with an app *directory*; a bare
  // .mjs path is not a valid app root. A tiny temp app imports this same file,
  // which then runs the electronMain() branch. URL stays in env, never argv.
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-soak-app-'));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'haloflux-soak', main: 'main.cjs' }));
  fs.writeFileSync(
    path.join(appDir, 'main.cjs'),
    `import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}).catch((error) => {\n`
      + `  console.error(error && error.stack ? error.stack : error);\n`
      + `  process.exit(1);\n`
      + `});\n`,
  );
  const child = spawn(ELECTRON, [appDir], {
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
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, minutes * 60 * 1000 + 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, error: error.message });
    });
  });
  await staticServer.close();
  fs.rmSync(appDir, { recursive: true, force: true });
  let renderer = null;
  if (fs.existsSync(rendererOut)) {
    try {
      renderer = JSON.parse(fs.readFileSync(rendererOut, 'utf8'));
    } catch {
      renderer = null;
    }
  }
  return { ...result, renderer, rendererOut, stdout: tail(stdout, 1000), stderr: tail(stderr, 2000), port };
}

function average(values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (clean.length === 0) return null;
  return Number((clean.reduce((sum, value) => sum + value, 0) / clean.length).toFixed(2));
}

async function nodeParent() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const reportPath = args.out
    ? path.resolve(ROOT, args.out)
    : path.join(EVIDENCE_DIR, `soak-${utcStamp()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const baseReport = {
    status: 'UNKNOWN',
    startedAt: startedAt.toISOString(),
    durationMinutes: args.minutes,
    eventsPerSecond: args.eventsPerSecond,
    rendererRequested: args.renderer,
    machine: machineInfo(),
    samples: [],
    rendererSamples: [],
    summary: {},
  };

  if (!fs.existsSync(BRIDGE_ENTRY)) {
    baseReport.status = 'NOT_READY';
    baseReport.reason = 'NOT_READY: packages/event-bridge/src/server.mjs missing';
    fs.writeFileSync(reportPath, `${JSON.stringify(baseReport, null, 2)}\n`);
    console.log(JSON.stringify({ status: baseReport.status, reason: baseReport.reason, report: reportPath }, null, 2));
    return 0;
  }

  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-soak-'));
  const token = crypto.randomBytes(32).toString('hex');
  let bridge;
  let electronResult = null;
  const factory = createEventFactory();
  await factory.init();

  try {
    bridge = await startBridge(port, home, token);
    const bridgeUrl = bridge.base;
    const events = [];
    let sent = 0;
    let accepted = 0;
    let postErrors = 0;
    let index = 0;
    let rendererPromise = null;

    if (args.renderer && fs.existsSync(RENDERER_INDEX) && fs.existsSync(ELECTRON)) {
      rendererPromise = runElectronRenderer({
        port,
        bridgeUrl,
        token,
        minutes: args.minutes,
        width: args.width,
        height: args.height,
        out: reportPath,
      });
    } else if (args.renderer && !fs.existsSync(RENDERER_INDEX)) {
      baseReport.rendererNote = 'NOT_READY: renderer missing; soak runs headless (no fps)';
    } else if (args.renderer && !fs.existsSync(ELECTRON)) {
      baseReport.rendererNote = `BLOCKED: Electron missing at ${ELECTRON}; soak runs headless (no fps)`;
    }

    const durationMs = args.minutes * 60 * 1000;
    const sampleEveryMs = 5000;
    const eventEveryMs = Math.max(30, Math.round(1000 / args.eventsPerSecond));
    const loopStart = Date.now();
    let nextSample = 0;
    let nextEvent = 0;
    let previousCpu = null;
    let previousCpuAt = null;

    while (Date.now() - loopStart < durationMs) {
      const now = Date.now();
      if (now >= nextEvent) {
        const event = factory.next(index);
        index += 1;
        sent += 1;
        postJson(bridgeUrl, token, '/v1/events', event).then((res) => {
          if (res.status === 202) accepted += 1;
          else postErrors += 1;
        });
        nextEvent = now + eventEveryMs;
      }
      if (now >= nextSample) {
        const state = await getJson(bridgeUrl, token, '/v1/state');
        const proc = bridge.child.pid ? await sampleProcessPowerShell(bridge.child.pid) : { rssBytes: 0, cpuSeconds: 0 };
        const cpuPercent = previousCpu === null
          ? null
          : Number(
              (
                ((proc.cpuSeconds - previousCpu) / ((now - (previousCpuAt ?? now)) / 1000) / Math.max(1, os.cpus().length)) *
                100
              ).toFixed(2),
            );
        const sample = {
          at: new Date(now).toISOString(),
          elapsedMs: now - loopStart,
          eventCount: state.json?.bridge?.eventCount ?? null,
          sessions: state.json?.sessions?.length ?? null,
          bridgeRssBytes: proc.rssBytes || null,
          bridgeCpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
          sent,
          accepted,
          postErrors,
        };
        events.push(sample);
        baseReport.samples = events;
        previousCpu = proc.cpuSeconds;
        previousCpuAt = now;
        console.log(
          `[soak] t=${(sample.elapsedMs / 1000).toFixed(0)}s events=${sample.eventCount} sessions=${sample.sessions} `
          + `rss=${proc.rssBytes ? (proc.rssBytes / 1048576).toFixed(1) : '?'}MB cpu=${sample.bridgeCpuPercent ?? '?'}%`,
        );
        nextSample = now + sampleEveryMs;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Let in-flight posts settle, then let Electron finish its own sampling.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (rendererPromise) {
      try {
        electronResult = await Promise.race([
          rendererPromise,
          new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 15000)),
        ]);
      } catch (error) {
        electronResult = { code: null, error: error.message };
      }
      if (electronResult?.renderer) {
        baseReport.rendererSamples = electronResult.renderer.samples ?? [];
        baseReport.rendererStatus = electronResult.renderer.status;
        baseReport.rendererError = electronResult.renderer.error ?? null;
      } else {
        baseReport.rendererStatus = 'FAIL';
        baseReport.rendererError = [
          electronResult?.error,
          electronResult?.stderr,
          electronResult?.stdout,
          'no renderer report',
        ].filter(Boolean).join(' | ').slice(0, 2000);
      }
    }

    const samples = baseReport.samples;
    const last = samples.at(-1) ?? {};
    const first = samples[0] ?? {};
    const rendererSamples = baseReport.rendererSamples.filter((sample) => typeof sample.fps === 'number');
    const steady = rendererSamples.slice(Math.floor(rendererSamples.length * 0.1));
    const heaps = rendererSamples.map((sample) => sample.heapUsedBytes).filter((value) => typeof value === 'number');
    const bridgeRss = samples.map((sample) => sample.bridgeRssBytes).filter(Boolean);
    const bridgeCpu = samples.map((sample) => sample.bridgeCpuPercent).filter((value) => typeof value === 'number');

    baseReport.summary = {
      durationActualMs: Date.now() - loopStart,
      samples: samples.length,
      eventsSent: last.sent ?? sent,
      eventsAccepted: last.accepted ?? accepted,
      postErrors: last.postErrors ?? postErrors,
      bridgeEventCount: last.eventCount ?? null,
      sessions: last.sessions ?? null,
      bridgeRssStartMB: first.bridgeRssBytes ? Number((first.bridgeRssBytes / 1048576).toFixed(2)) : null,
      bridgeRssEndMB: last.bridgeRssBytes ? Number((last.bridgeRssBytes / 1048576).toFixed(2)) : null,
      bridgeRssGrowthMB: first.bridgeRssBytes && last.bridgeRssBytes
        ? Number(((last.bridgeRssBytes - first.bridgeRssBytes) / 1048576).toFixed(2))
        : null,
      bridgeCpuMeanPercent: average(bridgeCpu),
      bridgeCpuMaxPercent: bridgeCpu.length ? Math.max(...bridgeCpu) : null,
      fpsMean: average(steady.map((sample) => sample.fps)),
      fpsMin: steady.length ? Math.min(...steady.map((sample) => sample.fps)) : null,
      fpsMax: steady.length ? Math.max(...steady.map((sample) => sample.fps)) : null,
      fpsSource: 'offscreen Electron window requestAnimationFrame probe',
      rendererHeapStartMB: heaps.length ? Number((heaps[0] / 1048576).toFixed(2)) : null,
      rendererHeapEndMB: heaps.length ? Number((heaps.at(-1) / 1048576).toFixed(2)) : null,
      rendererHeapGrowthMB: heaps.length ? Number(((heaps.at(-1) - heaps[0]) / 1048576).toFixed(2)) : null,
      rendererCpuMeanPercent: average(rendererSamples.map((sample) => sample.rendererCpuPercent).filter((value) => typeof value === 'number')),
      rendererPresent: baseReport.rendererSamples.length > 0,
    };

    baseReport.status = 'PASS';
    baseReport.completedAt = new Date().toISOString();
    baseReport.reason = baseReport.summary.rendererPresent
      ? 'completed with offscreen renderer sampling'
      : baseReport.rendererNote ?? 'completed headless (no renderer fps)';
  } catch (error) {
    baseReport.status = 'FAIL';
    baseReport.reason = error.message;
    baseReport.error = error.stack?.split('\n').slice(0, 6);
  } finally {
    if (bridge) await stopBridge(bridge);
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(baseReport, null, 2)}\n`);
  }

  // Summary table
  const s = baseReport.summary;
  const rows = [
    ['status', baseReport.status],
    ['duration (min)', args.minutes],
    ['samples', s.samples ?? 0],
    ['events sent/accepted', `${s.eventsSent ?? 0}/${s.eventsAccepted ?? 0}`],
    ['bridge eventCount', s.bridgeEventCount ?? 'n/a'],
    ['bridge RSS start鈫抏nd', `${s.bridgeRssStartMB ?? '?'} 鈫?${s.bridgeRssEndMB ?? '?'} MB`],
    ['bridge CPU mean/max', `${s.bridgeCpuMeanPercent ?? '?'}% / ${s.bridgeCpuMaxPercent ?? '?'}%`],
    ['renderer fps mean/min/max', s.rendererPresent ? `${s.fpsMean} / ${s.fpsMin} / ${s.fpsMax}` : 'n/a (headless)'],
    ['renderer heap start鈫抏nd', s.rendererPresent ? `${s.rendererHeapStartMB} 鈫?${s.rendererHeapEndMB} MB` : 'n/a'],
    ['renderer CPU mean', s.rendererPresent ? `${s.rendererCpuMeanPercent ?? '?'}%` : 'n/a'],
    ['report', path.relative(ROOT, reportPath)],
  ];
  console.log('\n| metric | value |');
  console.log('|---|---|');
  for (const [name, value] of rows) console.log(`| ${name} | ${value} |`);
  return baseReport.status === 'PASS' ? 0 : 1;
}

if (IS_ELECTRON) {
  await electronMain();
} else {
  process.exitCode = await nodeParent();
}

