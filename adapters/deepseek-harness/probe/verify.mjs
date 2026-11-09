/**
 * HALOFLUX DeepSeek Harness bridge — verification harness.
 *
 * Two independent checks:
 *
 *  1. OFFLINE (always runs): feeds real-shaped DSH session events through the
 *     production `BridgeRuntime` normalizer, posts them to the stub bridge, and
 *     asserts the six required HALOFLUX event types arrive, pass the frozen
 *     `@haloflux/event-schema` validator, and contain no prompt/args/result
 *     text. This proves the mapping and the privacy allowlist.
 *
 *  2. LIVE (when a probe log exists): reads the bounded probe log written by
 *     the bridge plugin running inside the real DSH Host and asserts the same
 *     six types were captured from live sessions with a real token usage.
 *
 *   node probe/verify.mjs
 *   node probe/verify.mjs --live-log C:\Users\Lenovo\AppData\Local\Temp\haloflux-dsh-bridge-events.jsonl --require-live
 */
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { createReceiver } from './receiver.mjs';
import { BridgeRuntime, resolveConfig } from '../haloflux-bridge/index.js';
import { validateEvent } from '../../../packages/event-schema/dist/index.js';

const REQUIRED_TYPES = ['session.start', 'task.received', 'tool.start', 'tool.end', 'run.end'];
const SECRETS = ['SECRET_PROMPT_TEXT', 'SECRET_ARGS', 'SECRET_RESULT', 'SECRET_MESSAGE'];

function silence() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function parseArgs(argv) {
  const out = { liveLog: '', requireLive: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live-log') out.liveLog = argv[++i];
    else if (arg === '--require-live') out.requireLive = true;
    else if (arg === '--json') out.json = true;
  }
  return out;
}

function t() {
  return Date.now();
}

async function offlineCheck() {
  const token = `verify-${Math.random().toString(16).slice(2)}-token`;
  const receiver = await createReceiver({ port: 0, token, quiet: true });
  const cfg = resolveConfig(
    {
      enabled: true,
      bridgeUrl: `http://127.0.0.1:${receiver.port}`,
      token,
      probeLog: 'off',
      heartbeatMs: 0,
      outputChunkThrottleMs: 0,
      maxEventsPerSecond: 200,
      queueLimit: 200,
      timeoutMs: 1000,
    },
    {},
    {},
  );
  const ctx = {
    logger: silence(),
    sessions: { list: () => [] },
    on() {},
    effect() {},
  };
  const runtime = new BridgeRuntime(ctx, cfg);
  runtime.start();
  const session = { id: 'session-verify-01' };
  const result = { pass: false, events: [], types: [], secretLeaks: [], error: null };
  try {
    runtime.onCreated(session);
    const now = t();
    const feed = (event) => runtime.onEvent(session, { time: now, ...event });
    feed({ type: 'turn/start', seq: 1, data: { turn: 1 } });
    feed({
      type: 'user/message',
      seq: 2,
      data: {
        role: 'user',
        id: 'm1',
        content: [{ type: 'text', text: 'SECRET_PROMPT_TEXT' }],
        source: { kind: 'user' },
      },
    });
    feed({ type: 'step/start', seq: 3, data: { turn: 1, step: 1 } });
    feed({
      type: 'assistant/chunk',
      seq: 4,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'SECRET_PROMPT_TEXT' } },
    });
    feed({
      type: 'tool/call',
      seq: 5,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: 'SECRET_ARGS' },
    });
    feed({
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          id: 'm2',
          isError: false,
          content: [{ type: 'tool_result', toolCallId: 'call-1', content: 'SECRET_RESULT' }],
          source: { kind: 'tool', callId: 'call-1' },
        },
      },
    });
    feed({
      type: 'assistant/message',
      seq: 7,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', id: 'm3', content: [{ type: 'text', text: 'SECRET_MESSAGE' }] },
        usage: { inputTokens: 100, outputTokens: 42, cacheReadTokens: 900 },
      },
    });
    feed({ type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } });
    // A failing tool proves tool.fail + errorCode without reading result text.
    feed({ type: 'turn/start', seq: 9, data: { turn: 2 } });
    feed({ type: 'step/start', seq: 10, data: { turn: 2, step: 1 } });
    feed({ type: 'tool/call', seq: 11, data: { turn: 2, step: 1, callId: 'call-2', name: 'pwsh', arguments: 'SECRET_ARGS' } });
    feed({
      type: 'tool/result',
      seq: 12,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'user',
          id: 'm4',
          isError: true,
          content: [{ type: 'tool_result', toolCallId: 'call-2', content: 'SECRET_RESULT' }],
          source: { kind: 'tool', callId: 'call-2' },
        },
        error: { name: 'ToolError', code: 'E_TOOL' },
      },
    });
    feed({ type: 'turn/end', seq: 13, data: { turn: 2, reason: { kind: 'completed' } } });

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && receiver.stats.accepted < 12) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    const events = receiver.events.slice();
    result.events = events;
    result.types = [...new Set(events.map((event) => event.eventType))];
    const schemaFailures = [];
    for (const event of events) {
      const checked = validateEvent(event);
      if (!checked.ok) schemaFailures.push(checked.errors);
    }
    const serialized = JSON.stringify(events);
    result.secretLeaks = SECRETS.filter((secret) => serialized.includes(secret));
    const tokenEvent = events.find((event) => event.metadata && event.metadata.tokenCount === 42);
    const calls = result.types.filter((type) => REQUIRED_TYPES.includes(type));
    result.pass =
      events.length >= 10 &&
      schemaFailures.length === 0 &&
      result.secretLeaks.length === 0 &&
      calls.length === REQUIRED_TYPES.length &&
      Boolean(tokenEvent) &&
      result.types.includes('tool.fail') &&
      events.every((event) => event.host === 'deepseek-harness' && event.schemaVersion === 1);
    result.schemaFailures = schemaFailures;
    result.tokenEvent = tokenEvent || null;
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
  } finally {
    await runtime.dispose();
    await receiver.close();
  }
  return result;
}

async function liveCheck(path) {
  const result = { path, exists: false, events: 0, types: [], sessions: 0, tokenEvents: 0, invalid: 0, pass: false, missing: [], diagnostics: [] };
  try {
    if (!existsSync(path)) return result;
    result.exists = true;
    const text = await readFile(path, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const sessions = new Set();
    const types = new Set();
    const missing = new Set(REQUIRED_TYPES);
    let invalid = 0;
    let tokenEvents = 0;
    let valid = 0;
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        invalid += 1;
        continue;
      }
      if (row && row.diag) {
        result.diagnostics.push(row.diag);
        continue;
      }
      const event = row && (row.event || row);
      const checked = validateEvent(event);
      if (!checked.ok) {
        invalid += 1;
        continue;
      }
      valid += 1;
      sessions.add(event.sessionId);
      types.add(event.eventType);
      missing.delete(event.eventType);
      if (event.metadata && typeof event.metadata.tokenCount === 'number') tokenEvents += 1;
    }
    result.events = valid;
    result.types = [...types];
    result.sessions = sessions.size;
    result.tokenEvents = tokenEvents;
    result.invalid = invalid;
    result.missing = [...missing];
    result.pass = valid >= 6 && missing.size === 0 && tokenEvents > 0 && invalid === 0;
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
  }
  return result;
}

async function gateCheck() {
  const result = { configOffPass: false, settingsOffPass: false, pass: false, error: null };
  const home = await mkdtemp(join(os.tmpdir(), 'haloflux-gate-'));
  const previousHome = process.env.HALOFLUX_HOME;
  let runtime;
  let receiver;
  try {
    receiver = await createReceiver({ port: 0, token: 'gate-check-token', quiet: true });
    const base = {
      bridgeUrl: `http://127.0.0.1:${receiver.port}`,
      token: 'gate-check-token',
      probeLog: 'off',
      heartbeatMs: 0,
      outputChunkThrottleMs: 0,
    };
    const ctx = { logger: silence(), sessions: { list: () => [] }, on() {}, effect() {} };
    const sample = (sessionId) => ({
      type: 'tool/call',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 1, callId: 'gate-call', name: 'pwsh', arguments: 'SECRET_ARGS' },
    });

    // 1. entry config disabled
    let cfg = resolveConfig({ ...base, enabled: false }, {}, {});
    runtime = new BridgeRuntime(ctx, cfg);
    runtime.start();
    runtime.onEvent({ id: 'gate-config-off' }, sample('gate-config-off'));
    await new Promise((r) => setTimeout(r, 350));
    result.configOffPass = receiver.stats.accepted === 0;
    await runtime.dispose();
    runtime = undefined;

    // 2. product settings.json `hosts.deepseek-harness.enabled = false`
    process.env.HALOFLUX_HOME = home;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'settings.json'), JSON.stringify({ hosts: { 'deepseek-harness': { enabled: false } } }), 'utf8');
    cfg = resolveConfig({ ...base, enabled: true }, {}, {});
    runtime = new BridgeRuntime(ctx, cfg);
    runtime.start();
    runtime.onEvent({ id: 'gate-settings-off' }, sample('gate-settings-off'));
    await new Promise((r) => setTimeout(r, 350));
    result.settingsOffPass = receiver.stats.accepted === 0;
    await runtime.dispose();
    runtime = undefined;
    result.pass = result.configOffPass && result.settingsOffPass;
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
  } finally {
    if (previousHome === undefined) delete process.env.HALOFLUX_HOME;
    else process.env.HALOFLUX_HOME = previousHome;
    if (runtime) await runtime.dispose();
    if (receiver) await receiver.close();
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const liveLog = resolve(args.liveLog || join(os.tmpdir(), 'haloflux-dsh-bridge-events.jsonl'));
  const offline = await offlineCheck();
  const gate = await gateCheck();
  const live = await liveCheck(liveLog);
  const summary = {
    timestamp: new Date().toISOString(),
    hostVersion: '0.2.1-rc.5',
    offline: {
      pass: offline.pass,
      received: offline.events.length,
      types: offline.types,
      tokenEvent: offline.tokenEvent,
      secretLeaks: offline.secretLeaks,
      schemaFailures: (offline.schemaFailures || []).length,
      error: offline.error,
    },
    gate,
    live: {
      pass: live.pass,
      log: live.path,
      exists: live.exists,
      events: live.events,
      sessions: live.sessions,
      types: live.types,
      tokenEvents: live.tokenEvents,
      invalid: live.invalid,
      missing: live.missing,
      diagnostics: live.diagnostics,
      error: live.error,
    },
  };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`OFFLINE ${offline.pass ? 'PASS' : 'FAIL'} received=${offline.events.length} types=${offline.types.join(',')}`);
    if (!offline.pass) {
      console.log(`  secretLeaks=${JSON.stringify(offline.secretLeaks)} schemaFailures=${(offline.schemaFailures || []).length} error=${offline.error || ''}`);
    }
    if (offline.tokenEvent) console.log(`  tokenEvent=${offline.tokenEvent.eventType} tokenCount=${offline.tokenEvent.metadata.tokenCount}`);
    console.log(`GATES   ${gate.pass ? 'PASS' : 'FAIL'} configOff=${gate.configOffPass} settingsOff=${gate.settingsOffPass}${gate.error ? ` error=${gate.error}` : ''}`);
    console.log(`LIVE    ${live.pass ? 'PASS' : live.exists ? 'PARTIAL' : 'NOT_TESTED'} log=${live.path}`);
    console.log(`  events=${live.events} sessions=${live.sessions} tokenEvents=${live.tokenEvents} invalid=${live.invalid}`);
    console.log(`  types=${live.types.join(',')}`);
    if (live.missing.length > 0) console.log(`  missing=${live.missing.join(',')}`);
  }
  if (!offline.pass || !gate.pass) process.exitCode = 1;
  else if (args.requireLive && !live.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FATAL ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
