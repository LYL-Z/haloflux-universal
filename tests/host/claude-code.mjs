#!/usr/bin/env node
/**
 * Host evidence: Claude Code (official lifecycle hooks).
 * Synthetic hook payloads prove the ADAPTER only (SIMULATED). A real Claude Code
 * process that reaches the bridge upgrades the host to PASS; without installed
 * hooks the real-session check is BLOCKED with the reason, never faked.
 */
import {
  ensureBridge, adapterExists, runSyntheticSequence, emitReport, readCapabilities,
  hooksInstalled, attemptRealSession, privacyFindings, which,
} from './_harness.mjs';

const host = 'claude-code';
const setup = await ensureBridge();
if (setup.blocked) {
  emitReport(host, { status: 'BLOCKED', reason: setup.blocked, checks: {} });
  process.exit(0);
}
const bridge = setup.bridge;
let report;
try {
  const secret = 'QA_SECRET_PROMPT_9f2c1b';
  const sessionId = `qa-claude-${Date.now().toString(36)}`;
  const base = {
    session_id: sessionId,
    cwd: 'D:\\HALOFLUX',
    model: 'claude-sonnet-4',
    permission_mode: 'default',
    tool_name: 'Read',
    tool_input: { file_path: `D:\\HALOFLUX\\${secret}.txt`, content: `${secret} prompt body` },
    tool_response: { output: secret },
  };
  const items = [
    ['SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' }, 'session.start'],
    ['UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: `${secret} prompt` }, 'task.received'],
    ['PreToolUse', { ...base, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_qa_1' }, 'tool.start'],
    ['PostToolUse', { ...base, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_qa_1' }, 'tool.end'],
    ['PostToolUseFailure', { ...base, hook_event_name: 'PostToolUseFailure', error: { code: 'E_QA' } }, 'tool.fail'],
    ['PermissionRequest', { ...base, hook_event_name: 'PermissionRequest' }, 'approval.request'],
    ['Stop', { ...base, hook_event_name: 'Stop' }, 'run.end'],
    ['SessionEnd', { ...base, hook_event_name: 'SessionEnd', reason: 'other' }, 'session.end'],
  ].map(([label, payload, expectedEvent]) => ({ label, payload, expectedEvent }));

  const synthetic = await runSyntheticSequence(host, items, { bridge });
  const receivedTypes = synthetic.events.map((event) => event.eventType);
  const missing = items.map((item) => item.expectedEvent).filter((type) => !receivedTypes.includes(type));
  const snapshot = await bridge.state();
  const leaked = privacyFindings(snapshot, [secret, 'QA_SECRET']);
  const adapterPresent = adapterExists(host);
  const cli = await which('claude');
  const installed = hooksInstalled(host);

  let status;
  let real;
  if (!adapterPresent) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: 'adapter missing' };
  } else if (missing.length > 0) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: `adapter mapping incomplete; missing ${missing.join(', ')}` };
  } else if (!installed) {
    status = 'SIMULATED';
    real = {
      status: 'BLOCKED',
      reason: 'Claude Code hooks for HALOFLUX are not installed in ~/.claude/settings.json; run scripts/install-adapters.ps1 first (not run by QA to avoid touching AgentHaven-managed hooks)',
    };
  } else if (!cli) {
    status = 'PARTIAL';
    real = { status: 'BLOCKED', reason: 'hooks installed but claude CLI not found on PATH' };
  } else {
    real = await attemptRealSession({
      bridge,
      host,
      command: 'claude',
      args: ['-p', 'Reply with exactly: HALOFLUX_QA_OK'],
      cwd: 'D:\\HALOFLUX',
      env: { HALOFLUX_BRIDGE_URL: bridge.base, HALOFLUX_TOKEN: bridge.token },
      timeoutMs: 180000,
    });
    if (real.status === 'PASS') {
      const realTypes = [...new Set((real.events ?? []).flatMap((view) => (view.recentEvents ?? []).map((item) => item.eventType)))];
      real.eventTypes = realTypes;
      const hasTool = realTypes.includes('tool.start') && realTypes.includes('tool.end');
      const hasCompletion = realTypes.includes('run.end');
      if (!hasTool || !hasCompletion) {
        status = 'PARTIAL';
        real.reason = `real Claude Code session observed (${realTypes.join(', ')}), but tool/completion events are missing because the host is not logged in (Not logged in · Please run /login)`;
      } else {
        status = 'PASS';
      }
    } else {
      status = 'PARTIAL';
    }
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
      privacy: { secretsChecked: ['QA_SECRET_PROMPT_9f2c1b'], leakedInState: leaked, pass: leaked.length === 0 },
    },
    real,
  };
} catch (error) {
  report = { status: 'BLOCKED', reason: `harness error: ${error.message}`, stack: error.stack?.split('\n').slice(0, 4) };
} finally {
  await bridge.stop();
}
emitReport(host, report);
process.exit(0);
