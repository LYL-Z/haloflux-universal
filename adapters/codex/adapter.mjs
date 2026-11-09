#!/usr/bin/env node
/**
 * HALOFLUX adapter — OpenAI Codex (`codex-cli 0.154.0`).
 *
 * Two ways to produce events, both implemented here:
 *
 * 1. HOOK MODE (default, installed by install.ps1)
 *    Codex 0.154.0 ships the `hooks` feature flag (verified: `codex features
 *    list` shows `hooks  stable  true`) and loads `~/.codex/hooks.json`
 *    (verified: `hooks.json`, `PreToolUse`, `PostToolUse`, `SessionStart`,
 *    `UserPromptSubmit`, `hookSpecificOutput` are strings inside
 *    `codex.exe`). The installer *creates* that file (it does not exist on this
 *    machine) and never touches the existing `notify = [...codex-computer-use…]`
 *    entry in `config.toml`.
 *    Payload arrives as JSON on stdin with `hook_event_name`, `session_id`,
 *    `tool_name`, `cwd`, `model`, … — mapped exactly like the Claude Code one.
 *    Output: nothing on stdout, exit 0. A PreToolUse hook can therefore never
 *    allow/deny a Codex tool call.
 *
 * 2. WATCH MODE (`--watch`, fallback when hooks are not trusted yet)
 *    Tails the Codex session rollout logs under
 *    `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, a *real* host-written event
 *    log (verified on this machine: 35k+ lines with `session_meta`,
 *    `event_msg/task_started`, `event_msg/task_complete`,
 *    `response_item/function_call`, `response_item/custom_tool_call`,
 *    `event_msg/token_count`).
 *    Because it is reconstructed from a log, every event is
 *    `source: 'derived'`, `confidence: 'inferred'` per architecture §4.1.
 *
 * Options: --watch [--once] [--interval 1000] [--tail-bytes 65536]
 *          --session-file <path>   (override the rollout file)
 */
import { homedir } from 'node:os';
import path from 'node:path';
import {
  runHookAdapter, makeEvent, toSessionId, readHostVersion, fallbackSessionId, safeString,
  safeToken, safeEnum, postEvents,
} from '../_shared/event-client.mjs';
import { listFiles, runWatchLoop } from '../_shared/watcher.mjs';

const HOST = 'codex';
const hostVersion = readHostVersion(HOST);
const CODE_HOME = process.env.CODEX_HOME || path.join(homedir(), '.codex');

/** Host enum values only — never arbitrary host text in `label`. */
const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'other'];
const COMPACT_TRIGGERS = ['manual', 'auto'];

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

function context(payload) {
  const sessionId = toSessionId(payload?.session_id, fallbackSessionId(HOST, payload?.cwd || ''));
  const cwdHint = safeString(
    typeof payload?.cwd === 'string' ? payload.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined,
    80,
  );
  const meta = {
    permissionMode: safeString(payload?.permission_mode, 40),
    model: safeString(payload?.model, 80),
    cwdHint,
  };
  return { base: { host: HOST, hostVersion, sessionId }, meta };
}

/* ------------------------------------------------------------------ hooks */

function mapHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const eventName = safeString(payload.hook_event_name || payload.hookEventName, 64);
  if (!eventName) return [];
  const { base, meta } = context(payload);
  const toolName = safeString(payload.tool_name, 80);

  switch (eventName) {
    case 'SessionStart':
      return [makeEvent({ ...base, eventType: 'session.start', state: 'connected', metadata: { ...meta, label: safeEnum(payload.source, SESSION_START_SOURCES) } })];
    case 'UserPromptSubmit':
      return [makeEvent({ ...base, eventType: 'task.received', state: 'running', metadata: { ...meta } })];
    case 'PreToolUse':
      return [makeEvent({ ...base, eventType: 'tool.start', state: 'tool', metadata: { ...meta, toolName, toolStatus: 'running' } })];
    case 'PermissionRequest':
      return [makeEvent({ ...base, eventType: 'approval.request', state: 'waiting_approval', metadata: { ...meta, toolName, approvalKind: 'tool' } })];
    case 'PostToolUse':
      return [makeEvent({ ...base, eventType: 'tool.end', state: 'running', metadata: { ...meta, toolName, toolStatus: 'ok' } })];
    case 'Stop':
      return [makeEvent({ ...base, eventType: 'run.end', state: 'idle', metadata: { ...meta, label: 'turn-end' } })];
    case 'SubagentStart':
      return [makeEvent({ ...base, eventType: 'run.start', state: 'running', metadata: { ...meta, agentName: safeToken(payload.agent_type, 40) } })];
    case 'SubagentStop':
      return [makeEvent({ ...base, eventType: 'run.end', state: 'idle', metadata: { ...meta, agentName: safeToken(payload.agent_type, 40) } })];
    case 'PreCompact':
    case 'PostCompact':
      return [makeEvent({ ...base, eventType: 'session.heartbeat', state: 'unknown', source: 'host-native', confidence: 'confirmed', metadata: { ...meta, label: `${eventName}:${safeEnum(payload.trigger, COMPACT_TRIGGERS, 'auto')}` } })];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------- watch */

function sessionIdFromFile(file) {
  const base = path.basename(file || '', '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return toSessionId(match ? match[1] : base, fallbackSessionId(HOST, 'codex-sessions'));
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Map one rollout JSONL record to zero or more derived events. */
export function mapRolloutLine(record, sessionId) {
  if (!record || typeof record !== 'object') return [];
  const outer = record.type;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const payloadType = payload.type;
  const base = { host: HOST, hostVersion, sessionId };
  const derived = { source: 'derived', confidence: 'inferred' };
  const model = safeString(payload.model, 80) || safeString(record.model, 80);

  if (outer === 'session_meta') {
    return [makeEvent({
      ...base, ...derived, eventType: 'session.start', state: 'connected',
      metadata: { model, label: 'session-meta' },
    })];
  }
  if (outer === 'event_msg' && payloadType === 'task_started') {
    return [makeEvent({
      ...base, ...derived, eventType: 'run.start', state: 'running',
      metadata: { model, contextLimit: number(payload.model_context_window) },
    })];
  }
  if (outer === 'event_msg' && payloadType === 'task_complete') {
    return [makeEvent({
      ...base, ...derived, eventType: 'run.end', state: 'idle',
      metadata: { durationMs: number(payload.duration_ms) },
    })];
  }
  if (outer === 'event_msg' && payloadType === 'turn_aborted') {
    return [makeEvent({ ...base, ...derived, eventType: 'error', state: 'error', metadata: { model, errorCode: 'turn-aborted' } })];
  }
  if (outer === 'response_item' && (payloadType === 'function_call' || payloadType === 'custom_tool_call')) {
    return [makeEvent({
      ...base, ...derived, eventType: 'tool.start', state: 'tool',
      metadata: { toolName: safeString(payload.name, 80), toolStatus: 'running', model },
    })];
  }
  if (outer === 'response_item' && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
    return [makeEvent({
      ...base, ...derived, eventType: 'tool.end', state: 'running',
      metadata: { toolStatus: 'ok', model },
    })];
  }
  if (outer === 'event_msg' && payloadType === 'token_count') {
    const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
    const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
    const usage = typeof last.total_tokens === 'number' ? last : (info.total_token_usage || {});
    return [makeEvent({
      ...base, ...derived, eventType: 'session.heartbeat', state: 'unknown',
      metadata: {
        model,
        tokenCount: number(usage.total_tokens ?? usage.output_tokens),
        contextLimit: number(info.model_context_window),
      },
    })];
  }
  return [];
}

async function runWatcher() {
  const explicit = argValue('session-file', '');
  const files = () => (explicit
    ? [path.resolve(explicit)]
    : listFiles(path.join(CODE_HOME, 'sessions'), { match: (_full, name) => /^rollout-.*\.jsonl$/i.test(name) }));
  const once = hasFlag('once');
  const intervalMs = Number(argValue('interval', '1000'));
  const tailBytes = Number(argValue('tail-bytes', '65536'));
  let total = 0;
  await runWatchLoop({
    host: HOST,
    files,
    once,
    intervalMs,
    tailBytes,
    onLines: async (lines, file) => {
      const sessionId = sessionIdFromFile(file);
      const events = [];
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        events.push(...mapRolloutLine(record, sessionId));
      }
      if (events.length === 0) return;
      total += events.length;
      const result = await postEvents(events);
      if (process.env.HALOFLUX_DEBUG === '1') {
        process.stderr.write(`[haloflux] codex watcher ${file} events=${events.length} posted=${result.ok}\n`);
      }
    },
  });
  if (once) process.stdout.write(`[codex-watcher] once: events=${total}\n`);
}

if (hasFlag('watch')) {
  try {
    await runWatcher();
  } catch (error) {
    if (process.env.HALOFLUX_DEBUG === '1') process.stderr.write(`[haloflux] watcher error ${error?.message}\n`);
  }
  process.exit(0);
} else {
  await runHookAdapter({ host: HOST, map: (payload) => mapHookPayload(payload) });
}
