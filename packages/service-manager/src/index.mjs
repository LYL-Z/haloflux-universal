/**
 * HALOFLUX service manager — singleton supervisor, Windows logon autostart and
 * startup diagnostics (P3.1).
 *
 * Design constraints:
 *  - current-user, no admin, no Session-0 GUI launch;
 *  - one supervisor per machine (exclusive lock + PID/command probe);
 *  - bounded exponential backoff; a user stop is never overridden;
 *  - every state change appended to a local JSONL audit log;
 *  - no secrets in logs/status.
 *
 * The scheduler-facing functions return plain data and accept an injectable
 * runner so tests never touch Task Scheduler.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export const TASK_NAME = 'HALOFLUX-Supervisor';
export const SERVICE_STATES = Object.freeze([
  'NOT_INSTALLED', 'INSTALLED', 'STARTING', 'HEALTHY', 'DEGRADED', 'STOPPING', 'STOPPED', 'FAILED',
]);

const ALLOWED = Object.freeze({
  NOT_INSTALLED: ['INSTALLED'],
  INSTALLED: ['STARTING', 'NOT_INSTALLED'],
  STARTING: ['HEALTHY', 'DEGRADED', 'FAILED', 'STOPPING'],
  HEALTHY: ['DEGRADED', 'STOPPING', 'FAILED'],
  DEGRADED: ['HEALTHY', 'STARTING', 'FAILED', 'STOPPING'],
  STOPPING: ['STOPPED', 'FAILED'],
  STOPPED: ['STARTING', 'INSTALLED', 'NOT_INSTALLED'],
  FAILED: ['STARTING', 'STOPPING', 'DEGRADED', 'HEALTHY'],
});

export function backoffDelay(attempt, { baseMs = 1000, maxMs = 30000 } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(maxMs, baseMs * 2 ** n);
}

export class ServiceStateMachine {
  constructor({ emit } = {}) {
    this.state = 'NOT_INSTALLED';
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.transitions = [];
  }

  can(next) {
    return (ALLOWED[this.state] || []).includes(next);
  }

  transition(next, reason = '') {
    if (!SERVICE_STATES.includes(next)) throw new Error(`unknown service state: ${next}`);
    if (next === this.state) return this.state;
    if (!this.can(next)) throw new Error(`illegal service transition ${this.state} -> ${next}`);
    const from = this.state;
    this.state = next;
    const record = { at: new Date().toISOString(), from, to: next, reason };
    this.transitions.push(record);
    this.emit(record);
    return next;
  }
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Build the PowerShell used for install/status/enable/disable/uninstall. */
export function autostartScript(action, {
  taskName = TASK_NAME,
  nodePath = process.execPath,
  scriptPath = path.resolve('scripts/haloflux.mjs'),
  root = path.resolve('.'),
  user = userInfo().username,
  delaySeconds = 15,
} = {}) {
  const name = psQuote(taskName);
  switch (action) {
    case 'install': {
      const argument = `"${scriptPath}" supervise`;
      return [
        "$ErrorActionPreference='Stop'",
        `$name=${name}`,
        `$action=New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(argument)} -WorkingDirectory ${psQuote(root)}`,
        `$trigger=New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(user)}`,
        `$trigger.Delay='PT${Math.max(0, Math.round(delaySeconds))}S'`,
        '$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)',
        `$principal=New-ScheduledTaskPrincipal -UserId ${psQuote(user)} -LogonType Interactive -RunLevel Limited`,
        `Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'HALOFLUX loopback monitor supervisor; current user only' -Force | Out-Null`,
        `$t=Get-ScheduledTask -TaskName $name; [pscustomobject]@{installed=$true;state=[string]$t.State;enabled=($t.State -ne 'Disabled');taskName=$name} | ConvertTo-Json -Compress`,
      ].join('; ');
    }
    case 'status':
      return [
        `$t=Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue`,
        "if(-not $t){ '{\"installed\":false}' } else {",
        `$i=Get-ScheduledTaskInfo -TaskName ${name} -ErrorAction SilentlyContinue`,
        "[pscustomobject]@{installed=$true;state=[string]$t.State;enabled=($t.State -ne 'Disabled');lastRunTime=$i.LastRunTime;lastTaskResult=$i.LastTaskResult;numberOfMissedRuns=$i.NumberOfMissedRuns} | ConvertTo-Json -Compress }",
      ].join('; ');
    case 'enable':
      return `$t=Get-ScheduledTask -TaskName ${name} -ErrorAction Stop; Enable-ScheduledTask -TaskName ${name} | Out-Null; [pscustomobject]@{installed=$true;enabled=$true;state=[string](Get-ScheduledTask -TaskName ${name}).State} | ConvertTo-Json -Compress`;
    case 'disable':
      return `$t=Get-ScheduledTask -TaskName ${name} -ErrorAction Stop; Disable-ScheduledTask -TaskName ${name} | Out-Null; [pscustomobject]@{installed=$true;enabled=$false;state=[string](Get-ScheduledTask -TaskName ${name}).State} | ConvertTo-Json -Compress`;
    case 'uninstall':
      return `$t=Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue; if($t){ Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }; '{\"installed\":false}'`;
    default:
      throw new Error(`unknown autostart action: ${action}`);
  }
}

/** Run PowerShell and optionally parse one JSON object. */
export function runPowerShell(script, { timeoutMs = 45000, exec = spawnSync } = {}) {
  const result = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  const stdout = (result.stdout || '').trim();
  let json = null;
  if (stdout) {
    const line = stdout.split(/\r?\n/).filter(Boolean).pop();
    try { json = JSON.parse(line); } catch { /* command may not return JSON */ }
  }
  return {
    ok: result.status === 0,
    status: result.status,
    json,
    stdout,
    stderr: (result.stderr || '').trim(),
  };
}

export function getAutostartStatus(options = {}) {
  const runner = options.runner || ((script) => runPowerShell(script, options));
  const result = runner(autostartScript('status', options));
  if (!result.ok) return { installed: false, enabled: false, error: result.stderr || 'powershell-failed' };
  let parsed = result.json;
  if (!parsed && result.stdout) {
    const line = String(result.stdout).split(/\r?\n/).filter(Boolean).pop();
    try { parsed = JSON.parse(line); } catch { parsed = null; }
  }
  return { installed: false, enabled: false, ...(parsed || {}) };
}

export function setAutostart(action, options = {}) {
  if (!['install', 'enable', 'disable', 'uninstall'].includes(action)) throw new Error(`unknown action: ${action}`);
  const runner = options.runner || ((script) => runPowerShell(script, options));
  const result = runner(autostartScript(action, options));
  if (!result.ok) return { ok: false, error: result.stderr || `powershell exit ${result.status}`, json: result.json };
  return { ok: true, json: result.json, installed: result.json?.installed };
}

/* ------------------------------------------------------------------ *
 * Supervisor
 * ------------------------------------------------------------------ */

export function supervisorPaths(home) {
  const run = path.join(home, 'run');
  return {
    home,
    run,
    lock: path.join(run, 'supervisor.lock'),
    state: path.join(run, 'supervisor.json'),
    stop: path.join(run, 'supervisor.stop'),
    log: path.join(home, 'logs', 'supervisor.jsonl'),
    pid: path.join(run, 'supervisor.pid'),
  };
}

export function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

export function writeJsonFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export function acquireSupervisorLock(paths, info = {}, { probe = null } = {}) {
  mkdirSync(paths.run, { recursive: true });
  const payload = {
    pid: info.pid || process.pid,
    startedAt: info.startedAt || new Date().toISOString(),
    command: info.command || 'supervise',
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(paths.lock, 'wx');
      writeSync(fd, JSON.stringify(payload));
      closeSync(fd);
      return { ok: true, info: payload };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readJsonFile(paths.lock) || {};
      const pid = Number(existing.pid) || 0;
      const alive = pid > 0 && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
      let matches = alive;
      if (alive && typeof probe === 'function') {
        try { matches = awaitMaybe(probe(pid, existing)); } catch { matches = false; }
      }
      if (alive && matches) return { ok: false, reason: 'already-running', existing };
      try { unlinkSync(paths.lock); } catch { /* race */ }
    }
  }
  return { ok: false, reason: 'lock-contended' };
}

export function releaseSupervisorLock(paths) {
  try { unlinkSync(paths.lock); } catch { /* already gone */ }
}

function awaitMaybe(value) {
  if (value && typeof value.then === 'function') throw new Error('probe must be synchronous');
  return value;
}

export function appendStateEvent(paths, record) {
  mkdirSync(path.dirname(paths.log), { recursive: true });
  writeFileSync(paths.log, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

/**
 * One supervisor decision. Pure enough to test: inject health/start functions.
 * Never restarts after the user wrote the stop flag.
 */
export async function supervisorTick({
  paths,
  machine,
  health,
  startBridge,
  startCollectors,
  now = Date.now,
  failures = { count: 0, nextAttemptAt: 0 },
  maxRestarts = 5,
  probeHosts = null,
} = {}) {
  if (existsSync(paths.stop)) {
    machine.transition('STOPPING', 'user-stop-flag');
    machine.transition('STOPPED', 'user-stop-flag');
    return { action: 'stopped', failures };
  }
  const healthy = await health();
  if (healthy) {
    if (machine.state !== 'HEALTHY') machine.transition('HEALTHY', 'bridge-health-ok');
    failures.count = 0;
    failures.nextAttemptAt = 0;
  } else {
    if (failures.count >= maxRestarts && now() < failures.nextAttemptAt) {
      machine.transition('FAILED', 'restart-budget-exhausted');
      return { action: 'failed', failures };
    }
    machine.transition('DEGRADED', 'bridge-health-failed');
    if (now() >= (failures.nextAttemptAt || 0)) {
      machine.transition('STARTING', 'restart-attempt');
      try {
        await startBridge();
        await startCollectors();
      } catch { /* handled by next health check */ }
      failures.count += 1;
      failures.nextAttemptAt = now() + backoffDelay(failures.count - 1);
    }
  }
  if (typeof probeHosts === 'function') {
    try { await probeHosts(); } catch { /* host discovery is advisory */ }
  }
  return { action: healthy ? 'healthy' : 'restarting', failures };
}

export class Supervisor {
  constructor({
    home,
    health,
    startBridge,
    startCollectors,
    probe = null,
    probeHosts = null,
    now = Date.now,
    intervalMs = 10000,
    maxRestarts = 5,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.paths = supervisorPaths(home);
    this.health = health;
    this.startBridge = startBridge;
    this.startCollectors = startCollectors;
    this.probe = probe;
    this.probeHosts = probeHosts;
    this.now = now;
    this.intervalMs = intervalMs;
    this.maxRestarts = maxRestarts;
    this.sleep = sleep;
    this.machine = new ServiceStateMachine({
      emit: (record) => appendStateEvent(this.paths, record),
    });
    this.failures = { count: 0, nextAttemptAt: 0 };
  }

  async init() {
    mkdirSync(this.paths.home, { recursive: true });
    const lock = acquireSupervisorLock(this.paths, { pid: process.pid, command: 'supervise' }, { probe: this.probe });
    if (!lock.ok) return lock;
    try { unlinkSync(this.paths.stop); } catch { /* no stale flag */ }
    writeFileSync(this.paths.pid, String(process.pid));
    if (this.machine.state === 'NOT_INSTALLED') this.machine.transition('INSTALLED', 'supervisor-start');
    if (this.machine.state === 'INSTALLED' || this.machine.state === 'STOPPED') {
      this.machine.transition('STARTING', 'supervisor-start');
    }
    return lock;
  }

  async tick() {
    const result = await supervisorTick({
      paths: this.paths,
      machine: this.machine,
      health: this.health,
      startBridge: this.startBridge,
      startCollectors: this.startCollectors,
      now: this.now,
      failures: this.failures,
      maxRestarts: this.maxRestarts,
      probeHosts: this.probeHosts,
    });
    this.failures = result.failures;
    writeJsonFile(this.paths.state, {
      pid: process.pid,
      state: this.machine.state,
      since: new Date().toISOString(),
      failures: this.failures,
      taskName: TASK_NAME,
    });
    return result;
  }

  async run({ durationMs = 0 } = {}) {
    const lock = await this.init();
    if (!lock.ok) return lock;
    const started = this.now();
    try {
      await this.tick();
      while (!existsSync(this.paths.stop)) {
        if (durationMs > 0 && this.now() - started >= durationMs) break;
        await this.sleep(this.intervalMs);
        await this.tick();
      }
      if (existsSync(this.paths.stop)) await this.tick();
    } finally {
      releaseSupervisorLock(this.paths);
      try { unlinkSync(this.paths.pid); } catch { /* gone */ }
    }
    return { ok: true, state: this.machine.state };
  }
}

/* ------------------------------------------------------------------ *
 * Host discovery / startup doctor
 * ------------------------------------------------------------------ */

export function hostConfigPaths(home = homedir()) {
  return {
    'deepseek-harness': path.join(home, '.dsh'),
    codex: path.join(home, '.codex', 'config.toml'),
    cursor: path.join(home, '.cursor'),
    workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
    'claude-code': path.join(home, '.claude', 'settings.json'),
    trae: path.join(home, '.trae-cn'),
  };
}

export function discoverHosts({
  home = homedir(),
  processList = [],
  state = null,
} = {}) {
  const installed = hostConfigPaths(home);
  const sessions = state?.sessions || [];
  const hostRows = state?.hosts || [];
  return Object.entries(installed).map(([host, target]) => {
    const hostSessions = sessions.filter((s) => s.host === host);
    const native = hostSessions.some((s) => s.source === 'host-native' && s.confidence === 'confirmed');
    const connected = hostRows.some((h) => h.host === host && h.connected === true);
    const running = Array.isArray(processList)
      ? processList.some((name) => String(name).toLowerCase().includes(host === 'deepseek-harness' ? 'deepseek' : host))
      : null;
    return {
      host,
      installed: existsSync(target),
      processRunning: running,
      login: 'UNKNOWN', // no host exposes a safe public login probe here
      bridgeConnected: connected,
      nativeEventsObserved: native,
      adapterInstalled: false, // refined by host adapters in HOST-MATRIX
      toolsTested: false,
    };
  });
}
