#!/usr/bin/env node
/**
 * Host evidence: DeepSeek Harness.
 *
 * The live DSH integration is owned by dsh-dev (Cordis bundle + probe). QA cannot
 * start a DSH Agent session from this CLI, but it CAN independently re-validate
 * the live probe evidence: every captured event must pass the frozen schema and
 * the required lifecycle types must be present. That is real host evidence (not
 * a simulation) and is reported as PASS with provenance, never as "QA drove DSH".
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoPath } from '../helpers/env.mjs';
import { emitReport, ensureBridge } from './_harness.mjs';

const host = 'deepseek-harness';
const candidates = [
  ['adapters', 'deepseek-harness', 'README.md'],
  ['docs', '04-dsh-integration.md'],
  ['tests', 'host', 'evidence', 'deepseek-harness.json'],
];
const artifacts = [];
for (const parts of candidates) {
  const file = repoPath(...parts);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  artifacts.push({
    file: parts.join('/'),
    bytes: Buffer.byteLength(text),
    hasPass: /\bPASS\b/.test(text),
    eventMentions: ['session.start', 'tool.start', 'run.start'].filter((type) => text.includes(type)),
    hasBridgeEvidence: /bridge|17817|v1\/events/i.test(text),
  });
}

// Independent verification of the live probe log written by the DSH bridge
// plugin inside the real DSH Host (dsh-dev evidence directory).
const schema = await import(new URL('../../packages/event-schema/dist/index.js', import.meta.url));
const liveLog = repoPath('adapters', 'deepseek-harness', 'probe', 'evidence', 'received-live.jsonl');
let liveEvidence = { file: 'adapters/deepseek-harness/probe/evidence/received-live.jsonl', present: false };
if (fs.existsSync(liveLog)) {
  const lines = fs.readFileSync(liveLog, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  const events = [];
  const invalid = [];
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid.push({ line: index + 1, error: 'json' });
      continue;
    }
    const result = schema.validateEvent(parsed);
    if (result.ok) events.push(parsed);
    else invalid.push({ line: index + 1, error: 'schema', issues: result.errors.slice(0, 3) });
  }
  const types = [...new Set(events.map((event) => event.eventType))];
  const sessions = [...new Set(events.map((event) => event.sessionId))];
  const required = ['session.start', 'task.received', 'tool.start', 'tool.end', 'run.end'];
  const missing = required.filter((type) => !types.includes(type));
  const times = events.map((event) => event.timestamp).filter(Number.isFinite);
  liveEvidence = {
    ...liveEvidence,
    present: true,
    events: events.length,
    invalid: invalid.length,
    invalidSamples: invalid.slice(0, 3),
    types,
    missingRequired: missing,
    sessions: sessions.length,
    hostVersions: [...new Set(events.map((event) => event.hostVersion))],
    sources: [...new Set(events.map((event) => event.source))],
    confidence: [...new Set(events.map((event) => event.confidence))],
    firstEventAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastEventAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

// Optional live check against a bridge the QA process owns. A plugin configured
// for 17817 will not reach this random port; report that honestly.
let bridgeCheck = { attempted: false, events: 0 };
const setup = await ensureBridge();
if (!setup.blocked) {
  bridgeCheck.attempted = true;
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const state = await setup.bridge.state();
      const views = (state.sessions ?? []).filter((session) => session.host === host);
      if (views.length > 0) {
        bridgeCheck.events = views.length;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await setup.bridge.stop();
  }
}

const toolEvidence = liveEvidence.present
  && liveEvidence.invalid === 0
  && liveEvidence.events >= 5
  && liveEvidence.types.includes('tool.start')
  && liveEvidence.types.includes('tool.end');
const fullLifecycle = toolEvidence
  && ['session.start', 'task.received', 'run.end'].every((type) => liveEvidence.types.includes(type));

let status;
let reason;
if (bridgeCheck.events > 0) {
  status = 'PASS';
  reason = `live DSH events observed on the QA bridge (${bridgeCheck.events} session view(s))`;
} else if (fullLifecycle) {
  status = 'PASS';
  reason = `dsh-dev live probe evidence re-validated by QA: ${liveEvidence.events} events pass schema v1, full lifecycle types present (${liveEvidence.types.join(', ')}), ${liveEvidence.sessions} real DSH session(s), source=${liveEvidence.sources.join('/')}. QA did not drive the DSH session itself (provenance: adapter probe log).`;
} else if (toolEvidence) {
  status = 'PARTIAL';
  reason = `live probe log re-validated (${liveEvidence.events} valid, 0 invalid, ${liveEvidence.sessions} DSH sessions) but it is a bounded mid-session window: tool/output events are proven, lifecycle types missing (${liveEvidence.missingRequired.join(', ')})`;
} else if (liveEvidence.present) {
  status = 'PARTIAL';
  reason = `live probe log present but incomplete: ${liveEvidence.events} valid, ${liveEvidence.invalid} invalid, missing ${liveEvidence.missingRequired.join(', ') || 'none'}`;
} else if (artifacts.length > 0) {
  status = 'BLOCKED';
  reason = `dsh-dev artifacts exist (${artifacts.map((item) => item.file).join(', ')}) but no live event log found`;
} else {
  status = 'BLOCKED';
  reason = 'NOT_READY: DeepSeek Harness integration artifacts missing (dsh-dev task-4)';
}

const capsFile = repoPath('adapters', 'deepseek-harness', 'capabilities.json');
let capabilities = null;
if (fs.existsSync(capsFile)) {
  try {
    capabilities = JSON.parse(fs.readFileSync(capsFile, 'utf8'));
  } catch {
    capabilities = null;
  }
}

emitReport(host, {
  status,
  reason,
  capabilities,
  checks: {
    artifacts,
    liveEvidence,
    liveBridge: bridgeCheck,
    probeHarness: fs.existsSync(repoPath('adapters', 'deepseek-harness', 'probe', 'verify.mjs')),
  },
  real: {
    status,
    evidence: path.relative(repoPath(), liveLog),
    provenance: 'dsh-dev live probe (real DSH Host sessions); QA independently re-validated the log',
  },
});
process.exit(0);
