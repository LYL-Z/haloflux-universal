#!/usr/bin/env node
/**
 * HALOFLUX Unified Agent Visualizer — operator CLI.
 *
 *   node scripts/haloflux.mjs start [--mode window|overlay|compact] [--demo]
 *   node scripts/haloflux.mjs bridge [--foreground]
 *   node scripts/haloflux.mjs companion [--mode ...]
 *   node scripts/haloflux.mjs stop
 *   node scripts/haloflux.mjs status [--json]
 *   node scripts/haloflux.mjs doctor [--json]
 *   node scripts/haloflux.mjs simulate [--loop]
 *   node scripts/haloflux.mjs watch start|stop|status
 *   node scripts/haloflux.mjs logs [--lines 80]
 *   node scripts/haloflux.mjs backup [--label name]
 *   node scripts/haloflux.mjs restore <timestamp> [--dry-run]
 *   node scripts/haloflux.mjs hosts
 *
 * Everything is local: loopback bridge, token auth, no telemetry.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync,
  readdirSync, statSync, openSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import http from 'node:http';
import {
  TASK_NAME, autostartScript, getAutostartStatus, setAutostart,
  supervisorPaths, Supervisor, discoverHosts, writeJsonFile, readJsonFile,
  releaseSupervisorLock,
} from '../packages/service-manager/src/index.mjs';
import { EventStore } from '../packages/event-store/src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HALOFLUX_HOME || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'HALOFLUX')
  : path.join(homedir(), '.haloflux'));
const RUN = path.join(HOME, 'run');
const LOGS = path.join(HOME, 'logs');
const TOKEN_FILE = path.join(HOME, 'token');
const BACKUPS = path.join(ROOT, 'config', 'backups');
const PORT = Number(process.env.HALOFLUX_BRIDGE_PORT || 17817);
const BRIDGE_URL = process.env.HALOFLUX_BRIDGE_URL || `http://127.0.0.1:${PORT}`;
const VERSION = readJson(path.join(ROOT, 'package.json'))?.version || '0.1.0';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function ensureDirs() {
  for (const dir of [HOME, RUN, LOGS, BACKUPS]) mkdirSync(dir, { recursive: true });
}

function token() {
  if (process.env.HALOFLUX_TOKEN) return process.env.HALOFLUX_TOKEN;
  try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function ensureToken() {
  ensureDirs();
  if (existsSync(TOKEN_FILE)) return token();
  const value = randomBytes(32).toString('hex');
  writeFileSync(TOKEN_FILE, value, { mode: 0o600 });
  return value;
}

function pidFile(name) { return path.join(RUN, `${name}.pid`); }

function readPid(name) {
  try {
    const pid = Number(readFileSync(pidFile(name), 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
}

function writePid(name, pid) {
  ensureDirs();
  writeFileSync(pidFile(name), String(pid));
}

function clearPid(name) {
  try { unlinkSync(pidFile(name)); } catch { /* already gone */ }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
  if (!alive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      // spawnSync: a detached taskkill can still be running when the pid file is
      // cleared, which previously left orphan bridges and duplicate collectors.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
    return true;
  } catch {
    try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
  }
}

function request(method, urlPath, body) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, BRIDGE_URL);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      },
      timeout: 2500,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function healthy() {
  const res = await request('GET', '/v1/health');
  return res.status === 200;
}

function waitFor(fn, timeoutMs, intervalMs = 200) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await fn()) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function logFile(name) { return path.join(LOGS, `${name}.log`); }

function spawnDetached(name, command, args, env) {
  ensureDirs();
  let fd = 'ignore';
  try { fd = openSync(logFile(name), 'a'); } catch { fd = 'ignore'; }
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  });
  child.unref();
  writePid(name, child.pid);
  return child.pid;
}

async function cmdBridge(foreground) {
  ensureToken();
  if (await healthy()) {
    console.log(`bridge already running at ${BRIDGE_URL}`);
    return 0;
  }
  const entry = path.join(ROOT, 'packages', 'event-bridge', 'src', 'server.mjs');
  if (!existsSync(entry)) {
    console.error(`bridge entry not found: ${entry}`);
    return 1;
  }
  if (foreground) {
    const child = spawn(process.execPath, [entry], { cwd: ROOT, stdio: 'inherit', env: process.env });
    return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  }
  const pid = spawnDetached('bridge', process.execPath, [entry], { HALOFLUX_BRIDGE_PORT: String(PORT) });
  const ok = await waitFor(healthy, 10000);
  if (ok) {
    console.log(`bridge started pid=${pid} url=${BRIDGE_URL} log=${logFile('bridge')}`);
    return 0;
  }
  console.error(`bridge failed to become healthy; see ${logFile('bridge')}`);
  return 1;
}

function electronBinary() {
  const candidates = [
    process.env.HALOFLUX_ELECTRON,
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(homedir(), '.dsh', 'electron', 'electron.exe'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) || '';
}

async function cmdCompanion(args) {
  const mode = argValue(args, '--mode', 'window');
  const demo = args.includes('--demo');
  const launcher = path.join(ROOT, 'scripts', 'launch-companion.mjs');
  if (!existsSync(launcher)) {
    console.error(`companion launcher missing: ${launcher}`);
    return 1;
  }
  // Never put a file:// URL in Electron's argv: on this machine that combination
  // terminates Electron before the main script runs. Config travels via env.
  const env = {
    HALOFLUX_BRIDGE_URL: BRIDGE_URL,
    HALOFLUX_TOKEN: token(),
    HALOFLUX_MODE: mode,
    HALOFLUX_DEMO: demo ? '1' : '0',
    HALOFLUX_REPLAY: argValue(args, '--replay', ''),
  };
  const replay = argValue(args, '--replay', '');
  const pid = spawnDetached('companion', process.execPath, [
    launcher, '--mode', mode,
    ...(demo ? ['--demo'] : []),
    ...(replay ? ['--replay', replay] : []),
  ], env);
  console.log(`companion started pid=${pid} mode=${mode}${demo ? ' demo' : ''} log=${logFile('companion')}`);
  return 0;
}

async function cmdStart(args) {
  const code = await cmdBridge(false);
  if (code !== 0) return code;
  // Read-only watchers for hosts without hook coverage (Codex, WorkBuddy).
  await cmdCollectors(['start']);
  return cmdCompanion(args);
}

async function cmdCollectors(args) {
  const entry = path.join(ROOT, 'scripts', 'collectors.mjs');
  if (!existsSync(entry)) {
    console.error('collectors supervisor missing: scripts/collectors.mjs');
    return 1;
  }
  const child = spawn(process.execPath, [entry, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

async function cmdAutostart(args) {
  if (process.platform !== 'win32') {
    console.error('autostart is currently implemented for Windows Task Scheduler only');
    return 2;
  }
  const action = args.find((a) => !a.startsWith('--')) || 'status';
  const asJson = args.includes('--json');
  const configFile = path.join(HOME, 'autostart.json');
  const options = {
    taskName: TASK_NAME,
    nodePath: process.execPath,
    scriptPath: path.join(ROOT, 'scripts', 'haloflux.mjs'),
    root: ROOT,
    user: process.env.USERNAME || undefined,
  };
  if (action === 'install' || action === 'enable' || action === 'disable' || action === 'uninstall') {
    const result = setAutostart(action, options);
    if (!result.ok) {
      console.error(`autostart ${action} failed: ${result.error}`);
      return 1;
    }
    if (action === 'install') {
      writeJsonFile(configFile, {
        taskName: TASK_NAME,
        installedAt: new Date().toISOString(),
        enabled: true,
        nodePath: options.nodePath,
        scriptPath: options.scriptPath,
        root: ROOT,
      });
    } else if (action === 'enable' || action === 'disable') {
      const cfg = readJsonFile(configFile) || { taskName: TASK_NAME };
      writeJsonFile(configFile, { ...cfg, enabled: action === 'enable', updatedAt: new Date().toISOString() });
    } else {
      try { unlinkSync(configFile); } catch { /* already gone */ }
    }
    console.log(`autostart ${action}: ${JSON.stringify(result.json || {})}`);
    return 0;
  }
  if (action !== 'status') {
    console.error('usage: node scripts/haloflux.mjs autostart install|status|enable|disable|uninstall [--json]');
    return 2;
  }
  const task = getAutostartStatus(options);
  const cfg = readJsonFile(configFile);
  const summary = {
    taskName: TASK_NAME,
    installed: !!task.installed,
    enabled: !!task.enabled,
    state: task.state || 'UNKNOWN',
    lastRunTime: task.lastRunTime || null,
    lastTaskResult: task.lastTaskResult ?? null,
    config: cfg || null,
    error: task.error || null,
  };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`task      ${summary.taskName}`);
    console.log(`installed ${summary.installed}   enabled=${summary.enabled}   state=${summary.state}`);
    console.log(`last run  ${summary.lastRunTime || '-'}   result=${summary.lastTaskResult ?? '-'}`);
    console.log(`config    ${cfg ? configFile : 'not installed by this project'}`);
    if (summary.error) console.log(`error     ${summary.error}`);
  }
  return summary.installed ? 0 : 1;
}

async function cmdSupervise(args) {
  const paths = supervisorPaths(HOME);
  const supervisor = new Supervisor({
    home: HOME,
    health: healthy,
    startBridge: async () => { await cmdBridge(false); },
    startCollectors: async () => { await cmdCollectors(['start']); },
    probeHosts: async () => {
      const state = await fetchState();
      writeJsonFile(path.join(HOME, 'run', 'hosts.json'), {
        at: new Date().toISOString(),
        hosts: discoverHosts({ state }),
      });
    },
  });
  if (args.includes('--once')) {
    const lock = await supervisor.init();
    if (!lock.ok) {
      console.log(`supervisor already running pid=${lock.existing?.pid || '?'}`);
      return 0;
    }
    try {
      const result = await supervisor.tick();
      console.log(`supervisor once action=${result.action} state=${supervisor.machine.state}`);
      return result.action === 'failed' ? 1 : 0;
    } finally {
      releaseSupervisorLock(paths);
      try { unlinkSync(paths.pid); } catch { /* gone */ }
    }
  }
  const seconds = Number(argValue(args, '--duration', '0'));
  console.log(`supervisor starting pid=${process.pid} log=${paths.log}`);
  const result = await supervisor.run({ durationMs: seconds > 0 ? seconds * 1000 : 0 });
  if (!result.ok) {
    console.log(`supervisor not started: ${result.reason} pid=${result.existing?.pid || '?'}`);
    return 0;
  }
  console.log(`supervisor stopped state=${result.state}`);
  return 0;
}

async function cmdHistory(args) {
  const store = new EventStore({ home: HOME });
  try {
    if (args.includes('--stats')) {
      console.log(JSON.stringify({ ...store.stats(), integrity: store.integrityCheck() }, null, 2));
      return 0;
    }
    const pruneIndex = args.indexOf('--prune-days');
    if (pruneIndex !== -1) {
      const days = Math.max(1, Number(args[pruneIndex + 1]) || 30);
      const result = store.pruneBefore(Date.now() - days * 86400000);
      store.vacuum();
      console.log(`pruned ${result.deleted} events older than ${days} days`);
      return 0;
    }
    const deleteSession = argValue(args, '--delete-session', '');
    if (deleteSession) {
      const result = store.deleteSession(deleteSession);
      store.vacuum();
      console.log(`deleted ${result.deleted} events for session ${deleteSession}`);
      return 0;
    }
    const result = store.query({
      sessionId: argValue(args, '--session', ''),
      runId: argValue(args, '--run', ''),
      traceId: argValue(args, '--trace', ''),
      from: Number(argValue(args, '--from', '0')),
      to: Number(argValue(args, '--to', '0')),
      limit: Number(argValue(args, '--limit', '200')),
    });
    const exportPath = argValue(args, '--export', '');
    if (exportPath) {
      const exported = store.exportJsonl(path.resolve(exportPath));
      console.log(`exported ${exported.exported} events -> ${exported.file}`);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`history total=${result.total} returned=${result.returned} window=${result.window.from || '-'}..${result.window.to || '-'}`);
    for (const event of result.events) {
      const tool = event.metadata?.toolName ? ` ${event.metadata.toolName}` : '';
      console.log(`${new Date(event.timestamp).toISOString()}  ${event.sessionId.slice(0, 24).padEnd(26)} ${event.eventType.padEnd(18)} ${event.source}/${event.confidence}${tool}`);
    }
    return 0;
  } catch (error) {
    console.error(`history failed: ${error && error.message ? error.message : error}`);
    return 1;
  } finally {
    store.close();
  }
}

async function cmdReplay(args) {
  const session = argValue(args, '--session', args.find((a) => !a.startsWith('--')) || '');
  if (!session) {
    console.error('usage: node scripts/haloflux.mjs replay --session <sessionId> [--mode window] [--speed 1]');
    return 2;
  }
  const store = new EventStore({ home: HOME });
  let total = 0;
  try { total = store.query({ sessionId: session, limit: 1 }).total; } finally { store.close(); }
  if (total === 0) {
    console.error(`no stored events for session: ${session}`);
    return 1;
  }
  const mode = argValue(args, '--mode', 'window');
  console.log(`replay ${session} (${total} events) mode=${mode} — window will show REPLAY`);
  return cmdCompanion(['--mode', mode, '--replay', session]);
}

async function cmdStop() {
  let stopped = 0;
  const paths = supervisorPaths(HOME);
  try { writeFileSync(paths.stop, String(Date.now())); } catch { /* best effort */ }
  // Collectors first: they only POST, so stop them before the bridge.
  const collectorEntry = path.join(ROOT, 'scripts', 'collectors.mjs');
  if (existsSync(collectorEntry)) {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [collectorEntry, 'stop'], { cwd: ROOT, stdio: 'inherit' });
      child.on('exit', () => resolve());
    });
  }
  const supPid = readPid('supervisor');
  if (supPid && alive(supPid)) {
    // Give the supervisor one tick to observe the stop flag and release its
    // lock, so Task Scheduler records a clean exit (result 0) instead of 1.
    const graceful = await waitFor(() => !alive(supPid), 12000, 250);
    if (graceful) {
      stopped += 1;
      console.log(`stopped supervisor pid=${supPid} (graceful)`);
    } else if (killTree(supPid)) {
      stopped += 1;
      console.log(`stopped supervisor pid=${supPid} (forced)`);
    }
    clearPid('supervisor');
  }
  for (const name of ['companion', 'bridge']) {
    const pid = readPid(name);
    if (pid && killTree(pid)) {
      stopped += 1;
      console.log(`stopped ${name} pid=${pid}`);
    }
    clearPid(name);
  }
  try { unlinkSync(paths.stop); } catch { /* no supervisor */ }
  // Only clear the singleton lock when the supervisor is really gone; if the
  // kill failed, removing the lock would allow a duplicate supervisor.
  let supervisorGone = true;
  try {
    const lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
    supervisorGone = !alive(Number(lock.pid) || 0);
  } catch { supervisorGone = !existsSync(paths.lock); }
  if (supervisorGone) {
    try { unlinkSync(paths.lock); } catch { /* already released */ }
  }
  if (stopped === 0) console.log('nothing running');
  return 0;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

async function fetchState() {
  const res = await request('GET', '/v1/state');
  return res.status === 200 ? res.json : undefined;
}

async function cmdStatus(asJson) {
  const health = await request('GET', '/v1/health');
  const state = health.status === 200 ? await fetchState() : undefined;
  const summary = {
    bridge: health.status === 200
      ? { ok: true, url: BRIDGE_URL, version: health.json?.version, uptimeMs: health.json?.uptimeMs }
      : { ok: false, url: BRIDGE_URL, error: health.error || `HTTP ${health.status}` },
    hosts: state?.hosts || [],
    sessions: (state?.sessions || []).map((s) => ({
      sessionId: s.sessionId, host: s.host, state: s.state, source: s.source,
      confidence: s.confidence, connected: s.connected, toolName: s.metrics?.toolName,
      tokensPerSecond: s.metrics?.tokensPerSecond,
    })),
    activeSessionId: state?.activeSessionId,
    companionPid: readPid('companion'),
    bridgePid: readPid('bridge'),
  };
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.bridge.ok ? 0 : 1;
  }
  console.log(`HALOFLUX v${VERSION}   home=${HOME}`);
  console.log(`bridge  ${summary.bridge.ok ? 'OK ' : 'DOWN'} ${BRIDGE_URL}${summary.bridge.ok ? `  up ${fmtDuration(summary.bridge.uptimeMs || 0)}` : `  (${summary.bridge.error})`}`);
  console.log(`pids    bridge=${summary.bridgePid || '-'} companion=${summary.companionPid || '-'}`);
  if (!summary.bridge.ok) {
    console.log('hint: node scripts/haloflux.mjs start');
    return 1;
  }
  console.log('');
  console.log('host                version        connected  sessions');
  for (const host of summary.hosts) {
    const count = summary.sessions.filter((s) => s.host === host.host).length;
    console.log(`${String(host.host).padEnd(20)}${String(host.hostVersion || '-').padEnd(15)}${String(!!host.connected).padEnd(11)}${count}`);
  }
  console.log('');
  if (summary.sessions.length === 0) {
    console.log('no sessions yet — start an agent, or run: node scripts/haloflux.mjs simulate');
  } else {
    console.log('session                         host            state             source        tool / tok/s');
    for (const s of summary.sessions) {
      const id = String(s.sessionId).slice(0, 30).padEnd(32);
      const extra = [s.toolName, s.tokensPerSecond ? `${s.tokensPerSecond} t/s` : ''].filter(Boolean).join(' ');
      console.log(`${id}${String(s.host).padEnd(16)}${String(s.state).padEnd(18)}${String(s.source).padEnd(14)}${extra}`);
    }
  }
  return 0;
}

async function cmdDoctor(args) {
  const asJson = args.includes('--json');
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok: !!ok, detail, hint });

  add('node', process.versions.node >= '22', process.versions.node, '需要 Node >= 22');
  const electron = electronBinary();
  add('electron', !!electron, electron || 'not found', '设置 HALOFLUX_ELECTRON 指向 electron.exe');
  add('token', !!token(), token() ? `${TOKEN_FILE} (${token().length} chars)` : 'missing', '启动一次 bridge 会自动生成');
  const health = await request('GET', '/v1/health');
  add('bridge', health.status === 200, health.status === 200 ? `${BRIDGE_URL} up ${fmtDuration(health.json?.uptimeMs || 0)}` : `${health.error || 'HTTP ' + health.status}`, 'node scripts/haloflux.mjs bridge');
  add('event-schema build', existsSync(path.join(ROOT, 'packages', 'event-schema', 'dist', 'index.js')), 'packages/event-schema/dist/index.js', 'npm run build');
  add('bridge source', existsSync(path.join(ROOT, 'packages', 'event-bridge', 'src', 'server.mjs')), 'packages/event-bridge/src/server.mjs', '等待模块落地');
  add('companion main', existsSync(path.join(ROOT, 'apps', 'companion', 'main', 'main.js')), 'apps/companion/main/main.js', '等待模块落地');
  add('renderer', existsSync(path.join(ROOT, 'apps', 'companion', 'renderer', 'index.html')), 'apps/companion/renderer/index.html', '等待模块落地');

  for (const [host, cfg] of Object.entries(HOST_CONFIGS)) {
    const installed = cfg.detect.some((p) => existsSync(expand(p)));
    add(`host:${host}`, installed, cfg.installHint, '未安装则只能做离线适配（SIMULATED）');
  }
  const backups = existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((d) => statSync(path.join(BACKUPS, d)).isDirectory()) : [];
  add('config backups', backups.length > 0, `${backups.length} snapshot(s) in config/backups`, '安装宿主适配器前会生成备份');
  add('dsh-haloflux (native overlay)', existsSync(path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-haloflux')), 'profile node_modules/dsh-haloflux', '由 plugin_manager 安装');

  if (args.includes('--startup')) {
    const task = getAutostartStatus({ root: ROOT, scriptPath: path.join(ROOT, 'scripts', 'haloflux.mjs') });
    add('autostart installed', task.installed, task.installed ? `${TASK_NAME} state=${task.state}` : 'not registered', 'node scripts/haloflux.mjs autostart install');
    add('autostart enabled', task.enabled, task.enabled ? 'enabled' : 'disabled', 'node scripts/haloflux.mjs autostart enable');
    const supPid = readPid('supervisor');
    add('supervisor process', alive(supPid), supPid || 'not running', 'node scripts/haloflux.mjs supervise');
    const supState = readJsonFile(path.join(HOME, 'run', 'supervisor.json'));
    add('supervisor state', !!supState, supState ? `${supState.state} since ${supState.since}` : 'no state file');
    const live = await fetchState();
    for (const row of discoverHosts({ state: live })) {
      add(`startup:${row.host}`, row.installed && (row.bridgeConnected || row.nativeEventsObserved),
        `installed=${row.installed} bridge=${row.bridgeConnected} native=${row.nativeEventsObserved} login=${row.login}`,
        '安装宿主或启动一次真实会话');
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ version: VERSION, home: HOME, checks }, null, 2));
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  console.log(`HALOFLUX doctor — v${VERSION}`);
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'WARN'}  ${c.name.padEnd(30)} ${c.detail}`);
    if (!c.ok && c.hint) console.log(`      hint: ${c.hint}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

const HOST_CONFIGS = {
  'deepseek-harness': { detect: ['~/.dsh'], installHint: '~/.dsh' },
  codex: { detect: ['~/.codex/config.toml'], installHint: '~/.codex' },
  cursor: { detect: ['~/.cursor', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'Cursor.exe'), path.join(process.env.PROGRAMFILES || '', 'Cursor', 'Cursor.exe')], installHint: 'Cursor' },
  workbuddy: { detect: ['~/.workbuddy/mcp.json'], installHint: '~/.workbuddy' },
  'claude-code': { detect: ['~/.claude/settings.json'], installHint: '~/.claude' },
  trae: { detect: ['~/.trae-cn'], installHint: '~/.trae-cn' },
};

function expand(p) {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

async function cmdSimulate(args) {
  const entry = path.join(ROOT, 'packages', 'event-bridge', 'src', 'simulator.mjs');
  if (!existsSync(entry)) {
    console.error('simulator not built yet: packages/event-bridge/src/simulator.mjs');
    return 1;
  }
  if (!(await healthy())) {
    console.error('bridge is down; run: node scripts/haloflux.mjs bridge');
    return 1;
  }
  const child = spawn(process.execPath, [entry, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

function cmdLogs(args) {
  const lines = Number(argValue(args, '--lines', '80'));
  for (const name of ['bridge', 'companion']) {
    const file = logFile(name);
    if (!existsSync(file)) continue;
    console.log(`\n=== ${name} (${file}) ===`);
    console.log(readFileSync(file, 'utf8').split('\n').slice(-Math.max(1, lines)).join('\n'));
  }
  return 0;
}

function cmdHosts() {
  console.log('host                installed  config root');
  for (const [host, cfg] of Object.entries(HOST_CONFIGS)) {
    const installed = cfg.detect.some((p) => existsSync(expand(p)));
    console.log(`${host.padEnd(20)}${String(installed).padEnd(11)}${cfg.installHint}`);
  }
  return 0;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function collectConfigFiles() {
  const home = homedir();
  return [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.codex', 'hooks.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.cursor', 'hooks.json'),
    path.join(home, '.trae-cn', 'mcp.json'),
    path.join(home, '.workbuddy', 'mcp.json'),
    path.join(home, '.dsh', 'cordis.patch.yml'),
    path.join(home, '.dsh', 'profiles', 'desktop', 'package.json'),
    path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
  ];
}

async function cmdBackup(args) {
  const label = argValue(args, '--label', 'manual');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUPS, `${stamp}-${label}`);
  mkdirSync(dir, { recursive: true });
  const manifest = { timestamp: new Date().toISOString(), label, files: [] };
  for (const file of collectConfigFiles()) {
    if (!existsSync(file)) continue;
    const rel = file.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '__');
    const data = readFileSync(file);
    writeFileSync(path.join(dir, rel), data);
    manifest.files.push({ source: file, backup: rel, bytes: data.length, sha256: sha256(data) });
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`backup written: ${dir} (${manifest.files.length} files)`);
  return 0;
}

function resolveBackupByPrefix(prefix) {
  if (!existsSync(BACKUPS)) return '';
  const dirs = readdirSync(BACKUPS).filter((d) => statSync(path.join(BACKUPS, d)).isDirectory());
  const hit = dirs.find((d) => d === prefix)
    || dirs.find((d) => d.startsWith(prefix))
    || dirs.find((d) => d.includes(prefix));
  return hit ? path.join(BACKUPS, hit) : '';
}

function cmdRestore(args) {
  const stamp = args.find((a) => !a.startsWith('--'));
  if (!stamp) {
    console.error('usage: haloflux restore <backup-dir-or-timestamp> [--dry-run]');
    return 2;
  }
  const dry = args.includes('--dry-run');
  const dir = existsSync(path.join(BACKUPS, stamp)) ? path.join(BACKUPS, stamp) : resolveBackupByPrefix(stamp);
  if (!dir) {
    console.error(`backup not found: ${stamp}`);
    const dirs = existsSync(BACKUPS) ? readdirSync(BACKUPS) : [];
    if (dirs.length) console.error(`available: ${dirs.join(', ')}`);
    return 1;
  }
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!manifest) {
    console.error(`manifest missing in ${dir}`);
    return 1;
  }
  let failures = 0;
  for (const file of manifest.files) {
    const backupPath = path.join(dir, file.backup);
    if (!existsSync(backupPath)) { console.error(`missing backup file ${backupPath}`); failures += 1; continue; }
    const data = readFileSync(backupPath);
    if (sha256(data) !== file.sha256) { console.error(`hash mismatch ${file.backup}`); failures += 1; continue; }
    if (dry) { console.log(`would restore ${file.source} (${data.length} bytes)`); continue; }
    mkdirSync(path.dirname(file.source), { recursive: true });
    writeFileSync(file.source, data);
    console.log(`restored ${file.source}`);
  }
  return failures === 0 ? 0 : 1;
}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  switch (command) {
    case 'start': return cmdStart(args);
    case 'bridge': return cmdBridge(args.includes('--foreground'));
    case 'companion': return cmdCompanion(args);
    case 'autostart': return cmdAutostart(args);
    case 'supervise': return cmdSupervise(args);
    case 'history': return cmdHistory(args);
    case 'replay': return cmdReplay(args);
    case 'stop': return cmdStop();
    case 'status': return cmdStatus(args.includes('--json'));
    case 'doctor': return cmdDoctor(args);
    case 'simulate': return cmdSimulate(args);
    case 'watch': return cmdCollectors(args);
    case 'logs': return cmdLogs(args);
    case 'backup': return cmdBackup(args);
    case 'restore': return cmdRestore(args);
    case 'hosts': return cmdHosts();
    case 'version': console.log(VERSION); return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log('commands: start bridge companion autostart supervise history replay stop status doctor simulate watch logs backup restore hosts version');
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      console.error('commands: start bridge companion autostart supervise history replay stop status doctor simulate watch logs backup restore hosts version');
      return 2;
  }
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error('haloflux failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
