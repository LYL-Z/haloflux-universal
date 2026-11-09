#!/usr/bin/env node
/**
 * HALOFLUX adapter — WorkBuddy 5.9.3 (`~/.workbuddy`).
 *
 * WorkBuddy exposes no passive lifecycle hook. What it *does* write is a real
 * OpenTelemetry-style trace log, verified on this machine:
 *
 *   ~/.workbuddy/traces/<pid>/trace_<32-hex>.jsonl
 *     {"type":"trace_start","trace":{traceId,name,workerPid,startedAt,...}}
 *     {"type":"span_start","span":{traceId,spanId,name,type,startedAt,status,...}}
 *     {"type":"span_end","span":{...duration,status,error}}
 *     {"type":"trace_end","trace":{...totalTokens},"summary":{...}}
 *
 * Observed span types: function (PowerShell/Bash/Write/TaskCreate/TaskUpdate),
 * custom (mcp_tools), generation, agent.
 *
 * This adapter tails the newest trace file and derives:
 *   trace_start                -> session.start
 *   span_start (function|custom)-> tool.start
 *   span_end   (function|custom)-> tool.end | tool.fail
 *   trace_end                  -> session.end (+ tokenCount from trace.totalTokens)
 *
 * Because these events are reconstructed from a log rather than delivered by a
 * host callback, they are `source: 'derived'`, `confidence: 'inferred'` (§4.1).
 *
 * PRIVACY: `summary.prompt`, `summary.*` text fields and `trace.metadata` are
 * never read. Only span `name`/`type`/`status`/`duration`, the trace id and the
 * numeric `totalTokens` leave this process.
 *
 * Usage:
 *   node adapter.mjs --watch [--once] [--interval 1000] [--tail-bytes 65536]
 *   node adapter.mjs --trace-file <path> --once
 */
import { homedir } from 'node:os';
import path from 'node:path';
import {
  makeEvent, toSessionId, readHostVersion, fallbackSessionId, safeString, safeNumber, postEvents,
} from '../_shared/event-client.mjs';
import { listFiles, runWatchLoop } from '../_shared/watcher.mjs';

const HOST = 'workbuddy';
const hostVersion = readHostVersion(HOST);
const WB_HOME = process.env.WORKBUDDY_HOME || path.join(homedir(), '.workbuddy');

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const TOOL_SPAN_TYPES = new Set(['function', 'custom']);

function num(value) {
  return safeNumber(value);
}

/** Map one WorkBuddy trace record to zero or more derived events. */
export function mapTraceRecord(record, fallbackSession) {
  if (!record || typeof record !== 'object') return [];
  const type = record.type;
  const trace = record.trace && typeof record.trace === 'object' ? record.trace : {};
  const span = record.span && typeof record.span === 'object' ? record.span : {};
  const traceId = trace.traceId || span.traceId;
  const sessionId = toSessionId(traceId, fallbackSession);
  const base = { host: HOST, hostVersion, sessionId };
  const derived = { source: 'derived', confidence: 'inferred' };

  if (type === 'trace_start') {
    // PRIVACY: trace.name can be derived from the user's prompt (QA verified a
    // prompt-derived trace name leaked through metadata.label). Never forward
    // trace.name / trace.agentName / summary.* text — constants only.
    return [makeEvent({
      ...base, ...derived, eventType: 'session.start', state: 'connected',
      metadata: { label: 'trace-start' },
    })];
  }

  if ((type === 'span_start' || type === 'span_end') && TOOL_SPAN_TYPES.has(span.type)) {
    const failed = span.status === 'error' || span.status === 'failed' || Boolean(span.error);
    const common = {
      ...base,
      metadata: {
        toolName: safeString(span.name, 80),
        toolCategory: safeString(span.type, 40),
        toolStatus: failed ? 'failed' : (type === 'span_end' ? 'ok' : 'running'),
        durationMs: type === 'span_end' ? num(span.duration) : undefined,
        // PRIVACY: span.error may contain a message with file/prompt fragments;
        // only a constant code is forwarded, never the message text.
        errorCode: failed ? 'span-error' : undefined,
      },
    };
    if (type === 'span_start') return [makeEvent({ ...common, ...derived, eventType: 'tool.start', state: 'tool' })];
    return [makeEvent({ ...common, ...derived, eventType: failed ? 'tool.fail' : 'tool.end', state: 'running' })];
  }

  if (type === 'trace_end') {
    return [makeEvent({
      ...base, ...derived, eventType: 'session.end', state: 'disconnected',
      metadata: {
        // Constant label only: trace.name is prompt-derived on this host.
        label: 'trace-end',
        tokenCount: num(trace.totalTokens),
        durationMs: num(trace.duration),
      },
    })];
  }

  return [];
}

async function runWatcher() {
  const explicit = argValue('trace-file', '');
  const files = () => (explicit
    ? [path.resolve(explicit)]
    : listFiles(path.join(WB_HOME, 'traces'), { match: (_full, name) => /^trace_.*\.jsonl$/i.test(name) }));
  const once = hasFlag('once');
  const intervalMs = Number(argValue('interval', '1000'));
  const tailBytes = Number(argValue('tail-bytes', '262144'));
  let total = 0;
  await runWatchLoop({
    host: HOST,
    files,
    once,
    intervalMs,
    tailBytes,
    onLines: async (lines, file) => {
      const fallbackSession = fallbackSessionId(HOST, path.basename(file || 'workbuddy'));
      const events = [];
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        events.push(...mapTraceRecord(record, fallbackSession));
      }
      if (events.length === 0) return;
      total += events.length;
      const result = await postEvents(events);
      if (process.env.HALOFLUX_DEBUG === '1') {
        process.stderr.write(`[haloflux] workbuddy watcher events=${events.length} posted=${result.ok}\n`);
      }
    },
  });
  if (once) process.stdout.write(`[workbuddy-watcher] once: events=${total}\n`);
}

if (hasFlag('watch')) {
  try {
    await runWatcher();
  } catch (error) {
    if (process.env.HALOFLUX_DEBUG === '1') process.stderr.write(`[haloflux] watcher error ${error?.message}\n`);
  }
  process.exit(0);
} else {
  // Default (no args) explains itself instead of silently idling.
  process.stdout.write(
    'HALOFLUX WorkBuddy adapter: use --watch to derive events from ~/.workbuddy/traces, '
    + 'or install the MCP status server (mcp-server.mjs).\n',
  );
  process.exit(0);
}
