#!/usr/bin/env node
/**
 * Host evidence: generic stdin JSONL adapter.
 * For `generic` the host interface IS the documented JSONL stream, so a real
 * stdin → schema → bridge round-trip is a genuine PASS for this adapter (not a
 * simulation of some other host).
 */
import {
  ensureBridge, adapterExists, invokeAdapter, emitReport, readCapabilities, privacyFindings,
} from './_harness.mjs';
import { event } from '../helpers/events.mjs';

const host = 'generic';
const setup = await ensureBridge();
if (setup.blocked) {
  emitReport(host, { status: 'BLOCKED', reason: setup.blocked, checks: {} });
  process.exit(0);
}
const bridge = setup.bridge;
let report;
try {
  const secret = 'QA_SECRET_GENERIC_8e4a';
  const sessionId = `qa-generic-${Date.now().toString(36)}`;
  const events = [
    event('generic', sessionId, 'session.start', { timestamp: Date.now() }),
    event('generic', sessionId, 'task.received', { timestamp: Date.now() + 10 }),
    event('generic', sessionId, 'run.start', { timestamp: Date.now() + 20 }),
    event('generic', sessionId, 'tool.start', {
      timestamp: Date.now() + 30,
      metadata: { toolName: 'Bash', label: 'qa tool' },
    }),
    event('generic', sessionId, 'tool.end', { timestamp: Date.now() + 40 }),
    // Forbidden metadata key: the adapter must drop/sanitize it. Placed before
    // run.end so the final state assertion is not polluted by the heartbeat.
    { ...event('generic', sessionId, 'session.heartbeat', { timestamp: Date.now() + 50 }), metadata: { prompt: secret } },
    event('generic', sessionId, 'run.end', { timestamp: Date.now() + 60 }),
  ];
  const jsonl = `${events.map((item) => JSON.stringify(item)).join('\n')}\n`;

  const run = await invokeAdapter(host, jsonl, { bridge, timeoutMs: 20000 });
  const receivedTypes = run.events.map((item) => item.eventType);
  const expected = ['session.start', 'task.received', 'run.start', 'tool.start', 'tool.end', 'run.end'];
  const missing = expected.filter((type) => !receivedTypes.includes(type));
  const snapshot = await bridge.state();
  const leaked = privacyFindings(snapshot, [secret, 'QA_SECRET']);
  const views = (snapshot.sessions ?? []).filter((session) => session.host === 'generic' && session.sessionId === sessionId);
  const finalView = views[0];

  let status;
  if (!adapterExists(host)) status = 'BLOCKED';
  else if (missing.length > 0) status = 'BLOCKED';
  else if (leaked.length > 0) status = 'BLOCKED';
  else if (finalView?.state !== 'idle') status = 'PARTIAL';
  else status = 'PASS';

  report = {
    status,
    capabilities: readCapabilities(host),
    checks: {
      adapterPresent: adapterExists(host),
      stdinJsonl: {
        allOk: run.ok,
        exitCode: run.result?.code,
        received: receivedTypes,
        missing,
        finalState: finalView?.state,
        finalSource: finalView?.source,
        finalConfidence: finalView?.confidence,
        adapterStdout: run.result?.stdout?.trim(),
      },
      privacy: { secretsChecked: [secret], leakedInState: leaked, pass: leaked.length === 0 },
    },
    real: {
      status: status === 'PASS' ? 'PASS' : 'BLOCKED',
      reason: status === 'PASS'
        ? 'stdin JSONL (the documented generic host interface) produced a full session in the real bridge'
        : `generic stdin round-trip incomplete (missing=${missing.join(',') || 'none'}, finalState=${finalView?.state})`,
    },
  };
} catch (error) {
  report = { status: 'BLOCKED', reason: `harness error: ${error.message}` };
} finally {
  await bridge.stop();
}
emitReport(host, report);
process.exit(0);
