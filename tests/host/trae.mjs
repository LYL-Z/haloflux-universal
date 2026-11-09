#!/usr/bin/env node
/**
 * Host evidence: TRAE CN 3.4.13.
 * TRAE has no headless CLI on this machine and its hook vocabulary is inferred;
 * every event is downgraded to derived/inferred by the adapter. Adapter proof is
 * synthetic; real GUI evidence is BLOCKED.
 */
import {
  ensureBridge, adapterExists, runSyntheticSequence, emitReport, readCapabilities,
  privacyFindings,
} from './_harness.mjs';

const host = 'trae';
const setup = await ensureBridge();
if (setup.blocked) {
  emitReport(host, { status: 'BLOCKED', reason: setup.blocked, checks: {} });
  process.exit(0);
}
const bridge = setup.bridge;
let report;
try {
  const secret = 'QA_SECRET_TRAE_7c3f';
  const sessionId = `qa-trae-${Date.now().toString(36)}`;
  const base = {
    session_id: sessionId,
    cwd: 'D:\\HALOFLUX',
    model: 'trae-agent',
    prompt: `${secret} prompt`,
    tool_input: { text: secret },
  };
  const items = [
    ['sessionStart', 'session.start'],
    ['beforeSubmitPrompt', 'task.received'],
    ['preToolUse', 'tool.start'],
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
  const downgraded = synthetic.events.every(
    (event) => event.source === 'derived' && event.confidence === 'inferred',
  );

  let status;
  let real;
  if (!adapterExists(host)) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: 'adapter missing' };
  } else if (missing.length > 0) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: `adapter mapping incomplete; missing ${missing.join(', ')}` };
  } else if (!downgraded) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: 'TRAE adapter events must all be source=derived/confidence=inferred; downgrade missing' };
  } else {
    status = 'SIMULATED';
    real = {
      status: 'BLOCKED',
      reason: 'TRAE has no headless CLI and its hook payload vocabulary is unverified; no real TRAE session can be driven by QA. Installer refuses hooks by default (-Mode Hooks required).',
    };
  }

  report = {
    status,
    capabilities: readCapabilities(host),
    checks: {
      adapterPresent: adapterExists(host),
      synthetic: {
        allOk: synthetic.allOk,
        received: receivedTypes,
        missing,
        downgradedToDerived: downgraded,
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
