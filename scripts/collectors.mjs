#!/usr/bin/env node
/**
 * HALOFLUX collectors — long-lived, read-only host watchers.
 *
 * Some hosts expose no hook that fires for every event (Codex CLI in this build
 * requires hook trust; WorkBuddy has no passive lifecycle hook). For those hosts
 * the adapter can *tail the host's own session log*, which is real host data but
 * reconstructed after the fact: every event is marked source=derived,
 * confidence=inferred by the adapter itself.
 *
 * This supervisor starts one adapter process per host in `--watch` mode,
 * records a pid file and a log, and stops them cleanly. It never writes to any
 * host directory and never reads prompt/tool content into events (the adapters
 * enforce that).
 *
 *   node scripts/collectors.mjs start [--hosts codex,workbuddy]
 *   node scripts/collectors.mjs stop
 *   node scripts/collectors.mjs status [--json]
 *   node scripts/collectors.mjs list
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HALOFLUX_HOME || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'HALOFLUX')
  : path.join(homedir(), '.haloflux'));
const RUN = path.join(HOME, 'run');
const LOGS = path.join(HOME, 'logs');

/** Adapters that implement `--watch` on a real, documented host log. */
export const WATCHERS = {
  codex: { adapter: 'adapters/codex/adapter.mjs', log: 'Codex session rollout JSONL', confidence: 'derived' },
  workbuddy: { adapter: 'adapters/workbuddy/adapter.mjs', log: 'WorkBuddy trace JSONL', confidence: 'derived' },
};

const pidPath = (host) => path.join(RUN, `collector-${host}.pid`);
const logPath = (host) => path.join(LOGS, `collector-${host}.log`);

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid(host) {
  try {
    const pid = Number(readFileSync(pidPath(host), 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function start(hosts) {
  mkdirSync(RUN, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  const started = [];
  for (const host of hosts) {
    const spec = WATCHERS[host];
    if (!spec) {
      console.log(`skip ${host}: no read-only watcher available (hooks-only host)`);
      continue;
    }
    const entry = path.join(ROOT, spec.adapter);
    if (!existsSync(entry)) {
      console.log(`skip ${host}: adapter missing ${spec.adapter}`);
      continue;
    }
    const existing = readPid(host);
    if (existing && alive(existing)) {
      console.log(`already running ${host} pid=${existing}`);
      started.push({ host, pid: existing, reused: true });
      continue;
    }
    let fd = 'ignore';
    try { fd = openSync(logPath(host), 'a'); } catch { fd = 'ignore'; }
    const child = spawn(process.execPath, [entry, '--watch', '--interval', '1000'], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        HALOFLUX_BRIDGE_URL: process.env.HALOFLUX_BRIDGE_URL || 'http://127.0.0.1:17817',
      },
    });
    child.unref();
    writeFileSync(pidPath(host), String(child.pid));
    console.log(`started ${host} pid=${child.pid} log=${logPath(host)} (${spec.log}, ${spec.confidence})`);
    started.push({ host, pid: child.pid, reused: false });
  }
  return started;
}

function stop() {
  let stopped = 0;
  for (const host of Object.keys(WATCHERS)) {
    const pid = readPid(host);
    if (pid && alive(pid)) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        stopped += 1;
        console.log(`stopped ${host} pid=${pid}`);
      } catch (err) {
        console.log(`could not stop ${host}: ${err.message}`);
      }
    }
    try { unlinkSync(pidPath(host)); } catch { /* gone */ }
  }
  if (!stopped) console.log('no collectors running');
  return stopped;
}

function status(asJson) {
  const rows = Object.keys(WATCHERS).map((host) => {
    const pid = readPid(host);
    return {
      host,
      running: alive(pid),
      pid: pid || null,
      log: logPath(host),
      source: WATCHERS[host].confidence,
      description: WATCHERS[host].log,
    };
  });
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log('collector  running  pid     source   host log');
  for (const row of rows) {
    console.log(`${row.host.padEnd(11)}${String(row.running).padEnd(9)}${String(row.pid || '-').padEnd(8)}${row.source.padEnd(9)}${row.description}`);
  }
  return 0;
}

function list() {
  for (const [host, spec] of Object.entries(WATCHERS)) {
    console.log(`${host}: ${spec.adapter}  (${spec.log}, source=${spec.confidence})`);
  }
  return 0;
}

function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  const hostArg = argValue(args, '--hosts', 'codex,workbuddy');
  const hosts = hostArg.split(',').map((h) => h.trim()).filter(Boolean);
  switch (command) {
    case 'start': start(hosts); return 0;
    case 'stop': stop(); return 0;
    case 'status': return status(args.includes('--json'));
    case 'list': return list();
    default:
      console.error(`unknown command: ${command}`);
      console.error('usage: collectors.mjs start|stop|status|list [--hosts codex,workbuddy] [--json]');
      return 2;
  }
}

process.exit(main());
