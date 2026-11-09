#!/usr/bin/env node
/**
 * Host evidence: Codex (`codex-cli 0.154.0`).
 * Hook payloads are mapped by adapters/codex/adapter.mjs. Synthetic hooks prove
 * the adapter; real evidence requires installed hooks (or the read-only rollout
 * watcher, which is derived/inferred by contract).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureBridge, adapterExists, invokeAdapter, runSyntheticSequence, emitReport,
  readCapabilities, hooksInstalled, attemptRealSession, privacyFindings, which,
} from './_harness.mjs';

const host = 'codex';

function findNewestFile(root, pattern) {
  let best = null;
  let bestMtime = -1;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && pattern.test(entry.name)) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > bestMtime) {
            bestMtime = mtime;
            best = full;
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root, 0);
  return best;
}

const setup = await ensureBridge();
if (setup.blocked) {
  emitReport(host, { status: 'BLOCKED', reason: setup.blocked, checks: {} });
  process.exit(0);
}
const bridge = setup.bridge;
let report;
try {
  const secret = 'QA_SECRET_CODEX_4d8e';
  const sessionId = `qa-codex-${Date.now().toString(36)}`;
  const base = {
    session_id: sessionId,
    cwd: 'D:\\HALOFLUX',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    tool_name: 'shell',
    tool_input: { command: `echo ${secret}`, body: `${secret} codex prompt` },
    tool_response: { output: secret },
  };
  const items = [
    ['SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' }, 'session.start'],
    ['UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: `${secret} prompt` }, 'task.received'],
    ['PreToolUse', { ...base, hook_event_name: 'PreToolUse' }, 'tool.start'],
    ['PermissionRequest', { ...base, hook_event_name: 'PermissionRequest' }, 'approval.request'],
    ['PostToolUse', { ...base, hook_event_name: 'PostToolUse' }, 'tool.end'],
    ['Stop', { ...base, hook_event_name: 'Stop' }, 'run.end'],
  ].map(([label, payload, expectedEvent]) => ({ label, payload, expectedEvent }));

  const synthetic = await runSyntheticSequence(host, items, { bridge });
  const receivedTypes = synthetic.events.map((event) => event.eventType);
  const missing = items.map((item) => item.expectedEvent).filter((type) => !receivedTypes.includes(type));
  const snapshot = await bridge.state();
  const leaked = privacyFindings(snapshot, [secret, 'QA_SECRET']);
  const adapterPresent = adapterExists(host);
  const cli = await which('codex');
  const installed = hooksInstalled(host);

  // Derived evidence from a real host-written rollout log, if present. This is
  // deliberately downgraded: source=derived, confidence=inferred. Copy the
  // newest rollout to temp so the shared watch-state offset cannot suppress it.
  let watcher = { attempted: false, events: 0, source: null };
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (adapterPresent && fs.existsSync(sessionsDir)) {
    watcher.attempted = true;
    const newest = findNewestFile(sessionsDir, /^rollout-.*\.jsonl$/i);
    if (newest) {
      const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-codex-real-'));
      const copy = path.join(copyDir, path.basename(newest));
      fs.copyFileSync(newest, copy);
      const run = await invokeAdapter(host, '', {
        bridge,
        args: ['--watch', '--session-file', copy, '--once', '--tail-bytes', '131072'],
        timeoutMs: 30000,
      });
      watcher.sourceFile = newest.replace(os.homedir(), '~');
      watcher.events = run.events.length;
      watcher.source = run.events[0]?.source ?? null;
      fs.rmSync(copyDir, { recursive: true, force: true });
    }
  }

  let status;
  let real;
  if (!adapterPresent) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: 'adapter missing' };
  } else if (missing.length > 0) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: `adapter mapping incomplete; missing ${missing.join(', ')}` };
  } else if (installed && cli) {
    real = await attemptRealSession({
      bridge,
      host,
      command: 'codex',
      args: ['exec', '--skip-git-repo-check', 'Reply with exactly: HALOFLUX_QA_OK'],
      cwd: 'D:\\HALOFLUX',
      env: { HALOFLUX_BRIDGE_URL: bridge.base, HALOFLUX_TOKEN: bridge.token },
      timeoutMs: 180000,
    });
    status = real.status === 'PASS' ? 'PASS' : watcher.events > 0 ? 'PARTIAL' : 'PARTIAL';
  } else if (watcher.events > 0) {
    status = 'PARTIAL';
    real = {
      status: 'PARTIAL',
      reason: `hooks not installed; read-only rollout watcher produced ${watcher.events} derived event(s) from real Codex session logs`,
    };
  } else {
    status = 'SIMULATED';
    real = {
      status: 'BLOCKED',
      reason: 'Codex hooks for HALOFLUX are not installed in ~/.codex/hooks.json and no rollout watcher events were produced; adapter verified with synthetic hook payloads only',
    };
  }

  report = {
    status,
    capabilities: readCapabilities(host),
    checks: {
      adapterPresent,
      cliDetected: cli,
      hooksInstalled: installed,
      synthetic: {
        allOk: synthetic.allOk,
        received: receivedTypes,
        missing,
        attempts: synthetic.attempts.map(({ label, expectedEvent, ok, exitCode, reason }) => ({
          label, expectedEvent, ok, exitCode, reason,
        })),
      },
      watcher,
      privacy: { secretsChecked: [secret], leakedInState: leaked, pass: leaked.length === 0 },
    },
    real,
  };
} catch (error) {
  report = { status: 'BLOCKED', reason: `harness error: ${error.message}` };
} finally {
  await bridge.stop();
}
emitReport(host, report);
process.exit(0);
