#!/usr/bin/env node
/**
 * Host evidence: WorkBuddy 5.9.3.
 * WorkBuddy has no passive hook API; the adapter tails the real OpenTelemetry
 * trace log. Both the fixture trace and a real trace produce derived/inferred
 * events by contract. Real-host evidence is therefore PARTIAL at best.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureBridge, adapterExists, invokeAdapter, emitReport, readCapabilities, privacyFindings,
} from './_harness.mjs';

const host = 'workbuddy';

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
let tempFile;
try {
  const secret = 'QA_SECRET_WORKBUDDY_2b7e';
  const traceId = `qa-wb-${Date.now().toString(36)}`;
  const records = [
    { type: 'trace_start', trace: { traceId, name: `${secret} trace`, startedAt: Date.now() } },
    { type: 'span_start', span: { traceId, spanId: 's1', name: 'PowerShell', type: 'function', startedAt: Date.now() } },
    { type: 'span_end', span: { traceId, spanId: 's1', name: 'PowerShell', type: 'function', duration: 120, status: 'ok' } },
    { type: 'trace_end', trace: { traceId, name: `${secret} trace`, totalTokens: 1234, duration: 500 } },
  ];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-wb-'));
  tempFile = path.join(tmpDir, 'trace_qa.jsonl');
  fs.writeFileSync(tempFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const fixture = await invokeAdapter(host, '', {
    bridge,
    args: ['--watch', '--trace-file', tempFile, '--once'],
    timeoutMs: 20000,
  });
  const receivedTypes = fixture.events.map((event) => event.eventType);
  const expected = ['session.start', 'tool.start', 'tool.end', 'session.end'];
  const missing = expected.filter((type) => !receivedTypes.includes(type));
  const downgraded = fixture.events.every(
    (event) => event.source === 'derived' && event.confidence === 'inferred',
  );
  const snapshot = await bridge.state();
  const leaked = privacyFindings(snapshot, [secret, 'QA_SECRET']);

  // Real host trace log (read-only watcher). Copy the newest real trace to a
  // temp file so the shared watch-state offset cannot suppress evidence.
  let realWatcher = { attempted: false, events: 0, sessionIds: [] };
  const tracesDir = path.join(os.homedir(), '.workbuddy', 'traces');
  if (adapterExists(host) && fs.existsSync(tracesDir)) {
    realWatcher.attempted = true;
    const newest = findNewestFile(tracesDir, /^trace_.*\.jsonl$/i);
    if (newest) {
      const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-wb-real-'));
      const copy = path.join(copyDir, path.basename(newest));
      fs.copyFileSync(newest, copy);
      const run = await invokeAdapter(host, '', {
        bridge,
        args: ['--watch', '--trace-file', copy, '--once', '--tail-bytes', '262144'],
        timeoutMs: 40000,
      });
      realWatcher.sourceFile = newest.replace(os.homedir(), '~');
      realWatcher.events = run.events.length;
      realWatcher.sessionIds = [...new Set(run.events.map((event) => event.sessionId))];
      realWatcher.source = run.events[0]?.source ?? null;
      fs.rmSync(copyDir, { recursive: true, force: true });
    }
  }

  let status;
  let real;
  if (!adapterExists(host)) {
    status = 'BLOCKED';
    real = { status: 'BLOCKED', reason: 'adapter missing' };
  } else if (leaked.length > 0) {
    status = 'BLOCKED';
    real = {
      status: 'BLOCKED',
      reason: `PRIVACY: adapter forwarded fixture content into the bridge state (${leaked.join(', ')}); trace names/tool labels must not carry host text`,
    };
  } else if (missing.length > 0 || !downgraded) {
    status = 'BLOCKED';
    real = {
      status: 'BLOCKED',
      reason: `fixture mapping incomplete (missing=${missing.join(',')}, derived=${downgraded})`,
    };
  } else if (realWatcher.events > 0) {
    status = 'PARTIAL';
    real = {
      status: 'PARTIAL',
      reason: `read-only watcher derived ${realWatcher.events} event(s) from real WorkBuddy trace logs (source=derived); WorkBuddy has no passive lifecycle hook, so real-time state is inferred, not confirmed`,
    };
  } else {
    status = 'SIMULATED';
    real = {
      status: 'BLOCKED',
      reason: 'no real WorkBuddy trace file produced events in --watch --once; adapter verified against a real-format fixture trace only',
    };
  }

  report = {
    status,
    capabilities: readCapabilities(host),
    checks: {
      adapterPresent: adapterExists(host),
      fixture: {
        allOk: fixture.ok,
        received: receivedTypes,
        missing,
        downgradedToDerived: downgraded,
        exitCode: fixture.result?.code,
      },
      realWatcher,
      privacy: { secretsChecked: [secret], leakedInState: leaked, pass: leaked.length === 0 },
    },
    real,
  };
} catch (error) {
  report = { status: 'BLOCKED', reason: `harness error: ${error.message}` };
} finally {
  await bridge.stop();
  if (tempFile) fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
}
emitReport(host, report);
process.exit(0);
