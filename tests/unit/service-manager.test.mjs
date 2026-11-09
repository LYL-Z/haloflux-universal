import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SERVICE_STATES, ServiceStateMachine, backoffDelay, autostartScript,
  getAutostartStatus, supervisorPaths, acquireSupervisorLock, releaseSupervisorLock,
  supervisorTick, discoverHosts, TASK_NAME,
} from '../../packages/service-manager/src/index.mjs';

test('backoff is exponential and capped', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(3), 8000);
  assert.equal(backoffDelay(20), 30000);
});

test('service state machine allows a healthy start and rejects illegal jumps', () => {
  const machine = new ServiceStateMachine();
  machine.transition('INSTALLED', 'test');
  machine.transition('STARTING', 'test');
  machine.transition('HEALTHY', 'test');
  assert.equal(machine.state, 'HEALTHY');
  assert.throws(() => machine.transition('NOT_INSTALLED'), /illegal service transition/);
  machine.transition('DEGRADED', 'test');
  machine.transition('FAILED', 'test');
  assert.equal(machine.transitions.length, 5);
  assert.ok(SERVICE_STATES.includes('FAILED'));
});

test('autostart install script is current-user, limited, single-instance and absolute', () => {
  const script = autostartScript('install', {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'D:\\HALOFLUX\\scripts\\haloflux.mjs',
    root: 'D:\\HALOFLUX',
    user: 'tester',
  });
  assert.match(script, /New-ScheduledTaskAction/);
  assert.match(script, /-WorkingDirectory 'D:\\HALOFLUX'/);
  assert.match(script, /-LogonType Interactive/);
  assert.match(script, /-RunLevel Limited/);
  assert.match(script, /MultipleInstances IgnoreNew/);
  assert.match(script, /supervise/);
  assert.match(script, /HALOFLUX-Supervisor/);
  assert.doesNotMatch(script, /SYSTEM|Highest/);
});

test('autostart status parser tolerates missing task and JSON output', () => {
  const missing = getAutostartStatus({
    runner: () => ({ ok: true, status: 0, stdout: '{"installed":false}', stderr: '' }),
  });
  assert.equal(missing.installed, false);
  const ready = getAutostartStatus({
    runner: () => ({
      ok: true, status: 0, stderr: '',
      stdout: JSON.stringify({ installed: true, enabled: true, state: 'Ready', lastTaskResult: 0 }),
    }),
  });
  assert.equal(ready.installed, true);
  assert.equal(ready.enabled, true);
  assert.equal(ready.state, 'Ready');
  assert.equal(TASK_NAME, 'HALOFLUX-Supervisor');
});

test('supervisor lock is exclusive and reclaims a dead PID', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-sup-'));
  const paths = supervisorPaths(home);
  mkdirSync(paths.run, { recursive: true });
  const first = acquireSupervisorLock(paths, { pid: process.pid, command: 'supervise' });
  assert.equal(first.ok, true);
  const second = acquireSupervisorLock(paths, { pid: process.pid, command: 'supervise' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-running');
  releaseSupervisorLock(paths);

  writeFileSync(paths.lock, JSON.stringify({ pid: 999999, startedAt: '2000-01-01T00:00:00Z' }));
  const reclaimed = acquireSupervisorLock(paths, { pid: process.pid, command: 'supervise' });
  assert.equal(reclaimed.ok, true);
  releaseSupervisorLock(paths);
  rmSync(home, { recursive: true, force: true });
});

test('supervisor tick health, restart backoff and stop flag are deterministic', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-tick-'));
  const paths = supervisorPaths(home);
  mkdirSync(paths.run, { recursive: true });
  let healthy = true;
  let starts = 0;
  let clock = 1000;
  const machine = new ServiceStateMachine();
  machine.transition('INSTALLED');
  machine.transition('STARTING');
  const first = await supervisorTick({
    paths, machine, health: async () => healthy,
    startBridge: async () => { starts += 1; }, startCollectors: async () => {},
    now: () => clock,
  });
  assert.equal(first.action, 'healthy');
  assert.equal(machine.state, 'HEALTHY');

  healthy = false;
  const second = await supervisorTick({
    paths, machine, health: async () => healthy,
    startBridge: async () => { starts += 1; }, startCollectors: async () => {},
    now: () => clock, failures: { count: 0, nextAttemptAt: 0 },
  });
  assert.equal(second.action, 'restarting');
  assert.equal(starts, 1);
  assert.equal(second.failures.count, 1);

  writeFileSync(paths.stop, '1');
  const stop = await supervisorTick({
    paths, machine, health: async () => true,
    startBridge: async () => {}, startCollectors: async () => {}, now: () => clock,
  });
  assert.equal(stop.action, 'stopped');
  assert.equal(machine.state, 'STOPPED');
  rmSync(home, { recursive: true, force: true });
});

test('host discovery separates installed, bridge-connected and native evidence', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'haloflux-hosts-'));
  mkdirSync(path.join(home, '.dsh'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), '');
  const rows = discoverHosts({
    home,
    state: {
      hosts: [{ host: 'deepseek-harness', connected: true }],
      sessions: [{ host: 'deepseek-harness', source: 'host-native', confidence: 'confirmed' }],
    },
  });
  const dsh = rows.find((row) => row.host === 'deepseek-harness');
  assert.equal(dsh.installed, true);
  assert.equal(dsh.bridgeConnected, true);
  assert.equal(dsh.nativeEventsObserved, true);
  assert.equal(dsh.login, 'UNKNOWN');
  const codex = rows.find((row) => row.host === 'codex');
  assert.equal(codex.installed, true);
  assert.equal(codex.nativeEventsObserved, false);
  rmSync(home, { recursive: true, force: true });
});
