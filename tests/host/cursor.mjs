#!/usr/bin/env node
/**
 * Host evidence: Cursor 3.29.9.
 * Cursor is a GUI host with a hooks file; QA cannot drive a real GUI session
 * headlessly, so adapter+installer evidence is SIMULATED/PARTIAL at most.
 */
import {
  ensureBridge, adapterExists, runSyntheticSequence, emitReport, readCapabilities,
  hooksInstalled, privacyFindings,
} from './_harness.mjs';

const host = 'cursor';
const setup = await ensureBridge();
if (setup.blocked) {
  emitReport(host, { status: 'BLOCKED', reason: setup.blocked, checks: {} });
  process.exit(0);
}
const bridge = setup.bridge;
let report;
try {
  const secret = 'QA_SECRET_CURSOR_5a1d';
  const sessionId = `qa-cursor-${Date.now().toString(36)}`;
  const base = {
    session_id: sessionId,
    cwd: 'D:\\HALOFLUX',
    model: 'cursor-agent',
    prompt: `${secret} prompt`,
    command: `echo ${secret}`,
    tool_input: { command: `echo ${secret}` },
  };
  const items = [
    ['sessionStart', 'session.start'],
    ['beforeSubmitPrompt', 'task.received'],
    ['beforeShellExecution', 'tool.start'],
    ['postToolUse', 'tool.end'],
    ['stop', 'run.end'],
    ['sessionEnd', 'session.end'],
  ].map(([eventName, expectedEvent]) => ({
    label: eventName,
    payload: { ...base, hook_event_name: eventName },
    expectedEvent,
    args: ['--event', eventName],
  }));

  const synthetic = await runSyntheticSequence(host, items, { bridge });
  const receivedTypes = synthetic.events.map((event) => event.eventType);
  const missing = items.map((item) => item.expectedEvent).filter((type) => !receivedTypes.includes(type));
  const snapshot = await bridge.state();
  const leaked = privacyFindings(snapshot, [secret, 'QA_SECRET']);
  const installed = hooksInstalled(host);

  let status;
  let real;
  if (!adapterExists(host)) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: 'adapter missing' };
  } else if (missing.length > 0) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: `adapter mapping incomplete; missing ${missing.join(', ')}` };
  } else if (installed) {
    status = 'PARTIAL';
    real = {
      status: 'BLOCKED',
      reason: 'Cursor hooks entry is installed, but Cursor is a GUI host with no headless session driver; no real Cursor session was observed by QA',
    };
  } else {
    status = 'SIMULATED';
    real = {
      status: 'BLOCKED',
      reason: 'Cursor hooks for HALOFLUX are not installed in ~/.cursor/hooks.json; adapter verified with synthetic hook payloads only',
    };
  }

  report = {
    status,
    capabilities: readCapabilities(host),
    checks: {
      adapterPresent: adapterExists(host),
      hooksInstalled: installed,
      synthetic: {
        allOk: synthetic.allOk,
        received: receivedTypes,
        missing,
        attempts: synthetic.attempts.map(({ label, expectedEvent, ok, exitCode, reason }) => ({
          label, expectedEvent, ok, exitCode, reason,
        })),
      },
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
