/**
 * Shared harness for tests/host/<host>.mjs evidence scripts.
 *
 * Rules (task-5 + docs/architecture.md §11):
 *  - A host becomes PASS only when a real host process caused real bridge
 *    events. Synthetic hook payloads prove the ADAPTER (SIMULATED), not the host.
 *  - Every script exits 0 and prints one JSON summary; evidence is written to
 *    tests/host/evidence/<host>.json.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, repoPath, waitFor } from '../helpers/env.mjs';
import { bridgeImplemented, startBridge } from '../helpers/bridge.mjs';

export const EVIDENCE_DIR = repoPath('tests', 'host', 'evidence');

export function adapterPath(host) {
  return repoPath('adapters', host, 'adapter.mjs');
}

export function adapterExists(host) {
  return fs.existsSync(adapterPath(host));
}

export function readCapabilities(host) {
  const file = repoPath('adapters', host, 'capabilities.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function hostConfigPath(host) {
  const home = os.homedir();
  switch (host) {
    case 'claude-code':
      return path.join(home, '.claude', 'settings.json');
    case 'codex':
      return path.join(home, '.codex', 'hooks.json');
    case 'cursor':
      return path.join(home, '.cursor', 'hooks.json');
    case 'trae':
      return path.join(home, '.trae-cn');
    case 'workbuddy':
      return path.join(home, '.workbuddy', 'mcp.json');
    case 'deepseek-harness':
      return path.join(home, '.dsh');
    default:
      return null;
  }
}

/** Whether the user's real host config currently contains a HALOFLUX hook. */
export function hooksInstalled(host) {
  const target = hostConfigPath(host);
  if (!target) return false;
  try {
    if (fs.statSync(target).isDirectory()) {
      return false;
    }
    return /haloflux/i.test(fs.readFileSync(target, 'utf8'));
  } catch {
    return false;
  }
}

export async function ensureBridge() {
  if (!bridgeImplemented()) {
    return { blocked: 'NOT_READY: packages/event-bridge/src/server.mjs is missing (bridge not implemented yet)' };
  }
  try {
    const bridge = await startBridge();
    return { bridge };
  } catch (error) {
    return { blocked: `bridge failed to start: ${error.message}` };
  }
}

export function runProcess(command, args, { input, cwd, env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd ?? ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 128 * 1024) stdout = stdout.slice(-64 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, error: error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Invoke an adapter with a host payload on stdin and wait for the bridge to
 * receive an event. Returns the ordered bridge state observed.
 */
export async function invokeAdapter(host, payload, { bridge, args = [], timeoutMs = 15000 } = {}) {
  if (!adapterExists(host)) {
    return { ok: false, reason: `NOT_READY: adapters/${host}/adapter.mjs is missing`, events: [] };
  }
  const before = await bridge.state();
  const beforeCounts = new Map(
    (before.sessions ?? []).map((session) => [session.sessionId, (session.recentEvents ?? []).length]),
  );
  const input = typeof payload === 'string' ? payload : payload === undefined ? '' : JSON.stringify(payload);
  const result = await runProcess(process.execPath, [adapterPath(host), ...args], {
    input,
    env: {
      HALOFLUX_BRIDGE_URL: bridge.base,
      HALOFLUX_TOKEN: bridge.token,
      HALOFLUX_TIMEOUT_MS: '3000',
    },
    timeoutMs,
  });

  let newEvents = [];
  try {
    await waitFor(
      async () => {
        const state = await bridge.state();
        newEvents = [];
        for (const session of state.sessions ?? []) {
          const start = beforeCounts.get(session.sessionId) ?? 0;
          const recent = session.recentEvents ?? [];
          for (const item of recent.slice(start)) {
            newEvents.push({
              ...item,
              sessionId: session.sessionId,
              host: session.host,
              state: session.state,
              source: session.source,
              confidence: session.confidence,
            });
          }
        }
        return newEvents.length > 0;
      },
      { timeoutMs: 6000, intervalMs: 120 },
    );
  } catch {
    /* reported below */
  }
  return { ok: result.code === 0 && newEvents.length > 0, result, events: newEvents, adapterExists: true };
}

export async function findHostSessions(bridge, host) {
  const state = await bridge.state();
  return (state.sessions ?? []).filter((session) => session.host === host);
}

/** Detect a CLI executable without running it. */
export async function which(command) {
  const result = await runProcess('where.exe', [command], { timeoutMs: 5000 });
  if (result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export async function runHostCli(command, args, { cwd, env, timeoutMs = 180000 } = {}) {
  const executable = await which(command);
  if (!executable) return { available: false, reason: `${command} not found on PATH` };
  const result = await runProcess(executable, args, { cwd, env, timeoutMs });
  return { available: true, executable, ...result };
}

/**
 * Try a real host session and return PASS only if bridge events arrive from a
 * host process while it runs.
 */
export async function attemptRealSession({ bridge, host, command, args, cwd, env, timeoutMs = 180000 }) {
  const before = await bridge.state();
  const previousCount = before.bridge?.eventCount ?? 0;
  const knownSessionIds = new Set((before.sessions ?? []).map((session) => session.sessionId));
  const startedAt = Date.now();
  const session = await runHostCli(command, args, { cwd, env, timeoutMs });
  if (!session.available) {
    return { status: 'BLOCKED', reason: session.reason, events: [] };
  }
  const deadline = Date.now() + 8000;
  let newSessions = [];
  while (Date.now() < deadline) {
    const state = await bridge.state();
    const hostSessions = (state.sessions ?? []).filter((item) => item.host === host);
    newSessions = hostSessions.filter((item) => !knownSessionIds.has(item.sessionId));
    if (newSessions.length > 0 || (state.bridge?.eventCount ?? 0) > previousCount) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (newSessions.length === 0) {
    return {
      status: 'BLOCKED',
      reason: `real ${host} process ran (exit ${session.code}) but created no new ${host} session in the bridge; hooks likely not installed/trusted or host rejected the turn`,
      events: [],
      session,
      beforeEventCount: previousCount,
      startedAt,
    };
  }
  return {
    status: 'PASS',
    reason: `real ${host} process produced ${newSessions.length} new session view(s) after ${new Date(startedAt).toISOString()}`,
    events: newSessions,
    session,
    startedAt,
  };
}

export function emitReport(host, report) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const payload = {
    host,
    generatedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      release: os.release(),
      node: process.version,
      cwd: ROOT,
    },
    ...report,
  };
  const file = path.join(EVIDENCE_DIR, `${host}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ ...payload, evidenceFile: path.relative(ROOT, file) }, null, 2));
  return payload;
}

export function statusOrder(status) {
  return { PASS: 0, PARTIAL: 1, SIMULATED: 2, BLOCKED: 3, UNSUPPORTED: 4, NOT_TESTED: 5 }[status] ?? 9;
}

/**
 * Shared synthetic-sequence runner used by hook-based hosts. Each item is a
 * representative host payload; the adapter maps it to one v1 event.
 */
export async function runSyntheticSequence(host, items, { bridge, args = [] } = {}) {
  const results = [];
  for (const item of items) {
    const run = await invokeAdapter(host, item.payload, { bridge, args: item.args ?? args });
    results.push({
      label: item.label,
      expectedEvent: item.expectedEvent,
      ok: run.ok,
      exitCode: run.result?.code,
      events: run.events,
      reason: run.reason,
      stdout: run.result?.stdout?.slice(0, 500),
      stderr: run.result?.stderr?.slice(0, 800),
    });
  }
  const received = results.flatMap((item) => item.events);
  return {
    attempts: results,
    received: received.length,
    allOk: results.every((item) => item.ok),
    events: received,
  };
}

export function privacyFindings(stateSnapshot, secrets) {
  const text = JSON.stringify(stateSnapshot);
  return secrets.filter((secret) => text.includes(secret));
}
