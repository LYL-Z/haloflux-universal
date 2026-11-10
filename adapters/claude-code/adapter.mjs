#!/usr/bin/env node
/**
 * HALOFLUX adapter — Claude Code (official lifecycle hooks).
 *
 * Install: `install.ps1` deep-merges one extra hook command into each existing
 * event array of `%USERPROFILE%\.claude\settings.json`, preserving every
 * AgentHaven-managed entry (30 hooks on this machine). Uninstall restores the
 * byte-identical backup captured in `config/backups/<utc>/`.
 *
 * Runtime contract: Claude Code pipes the hook payload as JSON on stdin. This
 * adapter maps it to HALOFLUX event v1, POSTs to the loopback bridge with a
 * 1500 ms budget and **always exits 0**. It writes nothing to stdout, so a
 * PreToolUse / PermissionRequest hook can never alter a permission decision.
 *
 * Mapping (docs/architecture.md §4.1):
 *   SessionStart        -> session.start   (connected)
 *   UserPromptSubmit    -> task.received   (running)
 *   PreToolUse          -> tool.start      (tool)
 *   PostToolUse         -> tool.end        (running)
 *   PostToolUseFailure  -> tool.fail       (running)
 *   PermissionRequest   -> approval.request(waiting_approval)
 *   Stop                -> run.end         (idle)
 *   StopFailure         -> error           (error)
 *   SessionEnd          -> session.end     (disconnected)
 *
 * Never read: `tool_input`, `tool_response`, `prompt`, or the contents of
 * `transcript_path`. Only `tool_name`, `session_id`, `cwd` basename, `model`,
 * `permission_mode` and coarse `source`/`reason` labels leave this process.
 */
import {
  runHookAdapter, makeEvent, toSessionId, readHostVersion, fallbackSessionId, safeString,
  safeToken, safeEnum,
} from '../_shared/event-client.mjs';

const HOST = 'claude-code';
const hostVersion = readHostVersion(HOST);

/** Host enum values only — never arbitrary host text in `label`. */
const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'other'];
const SESSION_END_REASONS = [
  'clear', 'resume', 'logout', 'prompt_input_exit', 'bypass_permissions_disabled', 'other',
];
const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'];

const labelOf = (value, allowed) => safeEnum(value, allowed);
const errorCodeOf = (payload) => {
  // Host payloads carry no stable error code; only fall back to a coarse label
  // (never to an error message, which could contain paths or user text).
  const status = payload?.error && typeof payload.error === 'object' ? payload.error.code : undefined;
  return safeToken(status, 64);
};

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

function mapPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const eventName = safeString(payload.hook_event_name || payload.hookEventName, 64);
  if (!eventName) return [];
  const { base, meta } = context(payload);

  switch (eventName) {
    case 'SessionStart':
      return [makeEvent({
        ...base,
        eventType: 'session.start',
        state: 'connected',
        metadata: { ...meta, label: labelOf(payload.source, SESSION_START_SOURCES), agentName: safeToken(payload.agent_type, 40) },
      })];
    case 'UserPromptSubmit':
      return [makeEvent({ ...base, eventType: 'task.received', state: 'running', metadata: { ...meta } })];
    case 'PreToolUse':
      return [makeEvent({
        ...base,
        eventType: 'tool.start',
        state: 'tool',
        metadata: {
          ...meta,
          toolName: safeString(payload.tool_name, 80),
          toolStatus: 'running',
          toolCallId: safeString(payload.tool_use_id, 64),
        },
      })];
    case 'PostToolUse':
      return [makeEvent({
        ...base,
        eventType: 'tool.end',
        state: 'running',
        metadata: {
          ...meta,
          toolName: safeString(payload.tool_name, 80),
          toolStatus: 'ok',
          toolCallId: safeString(payload.tool_use_id, 64),
        },
      })];
    case 'PostToolUseFailure':
      return [makeEvent({
        ...base,
        eventType: 'tool.fail',
        state: 'running',
        metadata: {
          ...meta,
          toolName: safeString(payload.tool_name, 80),
          toolStatus: 'failed',
          errorCode: errorCodeOf(payload),
          toolCallId: safeString(payload.tool_use_id, 64),
        },
      })];
    case 'PermissionRequest':
      return [makeEvent({
        ...base,
        eventType: 'approval.request',
        state: 'waiting_approval',
        metadata: {
          ...meta,
          toolName: safeString(payload.tool_name, 80),
          approvalKind: safeString(payload.permission_mode, 40) || 'tool',
        },
      })];
    case 'Stop':
      return [makeEvent({
        ...base,
        eventType: 'run.end',
        state: 'idle',
        metadata: {
          ...meta,
          label: safeString(payload.stop_hook_active ? 'stop-hook-active' : 'turn-end', 120),
        },
      })];
    case 'StopFailure':
      return [makeEvent({
        ...base,
        eventType: 'error',
        state: 'error',
        metadata: { ...meta, errorCode: errorCodeOf(payload) || 'stop-failure' },
      })];
    case 'SessionEnd':
      return [makeEvent({
        ...base,
        eventType: 'session.end',
        state: 'disconnected',
        metadata: { ...meta, label: labelOf(payload.reason, SESSION_END_REASONS) },
      })];
    default:
      // Deliberately unmapped: ConfigChange, CwdChanged, FileChanged,
      // InstructionsLoaded, Notification, Pre/PostCompact, Subagent*,
      // TaskCreated/TaskCompleted, TeammateIdle, WorktreeRemove, Elicitation*.
      return [];
  }
}

// A hook must never fail the host: runHookAdapter wraps everything and exits 0.
await runHookAdapter({ host: HOST, map: (payload) => mapPayload(payload) });
