/**
 * HALOFLUX — shared mapper for "Cursor-style" hooks.json hooks.
 *
 * Cursor (3.29.9) and TRAE CN (3.4.13) are both VS Code-derived agents whose
 * hook runners receive a JSON payload on stdin with a hook event name. The
 * event vocabulary below is taken from the Cursor workbench bundle on this
 * machine (`workbench.desktop.main.js`, variable `m4r`):
 *
 *   beforeShellExecution beforeMCPExecution afterShellExecution
 *   afterMCPExecution beforeReadFile afterFileEdit beforeTabFileRead
 *   afterTabFileEdit stop beforeSubmitPrompt afterAgentResponse
 *   afterAgentThought sessionStart sessionEnd preCompact subagentStart
 *   subagentStop preToolUse postToolUse postToolUseFailure workspaceOpen
 *
 * Hook stdout is intentionally empty: Cursor/TRAE command hooks may accept JSON
 * decisions on stdout, and HALOFLUX must never change a permission decision.
 */
import { makeEvent, toSessionId, fallbackSessionId, safeString, safeToken, safeEnum } from './event-client.mjs';

/** Host enum values only — never arbitrary host text. */
const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'other'];
const STOP_REASONS = [
  'clear', 'resume', 'logout', 'prompt_input_exit', 'bypass_permissions_disabled',
  'other', 'end_turn', 'max_tokens', 'stop_sequence',
];

const TOOL_EVENTS = {
  beforeShellExecution: { type: 'tool.start', state: 'tool', tool: 'Shell' },
  afterShellExecution: { type: 'tool.end', state: 'running', tool: 'Shell' },
  beforeMCPExecution: { type: 'tool.start', state: 'tool', tool: 'MCP' },
  afterMCPExecution: { type: 'tool.end', state: 'running', tool: 'MCP' },
  beforeReadFile: { type: 'tool.start', state: 'tool', tool: 'Read' },
  afterFileEdit: { type: 'tool.end', state: 'running', tool: 'Write' },
  preToolUse: { type: 'tool.start', state: 'tool' },
  postToolUse: { type: 'tool.end', state: 'running' },
  postToolUseFailure: { type: 'tool.fail', state: 'running' },
};

const SIMPLE_EVENTS = {
  sessionStart: { eventType: 'session.start', state: 'connected' },
  sessionEnd: { eventType: 'session.end', state: 'disconnected' },
  workspaceOpen: { eventType: 'host.connected', state: 'connected' },
  beforeSubmitPrompt: { eventType: 'task.received', state: 'running' },
  stop: { eventType: 'run.end', state: 'idle' },
  subagentStart: { eventType: 'run.start', state: 'running' },
  subagentStop: { eventType: 'run.end', state: 'idle' },
  preCompact: { eventType: 'session.heartbeat', state: 'unknown' },
};

/** Ignored on purpose: streaming output and Tab noise would flood the bridge. */
const IGNORED = new Set([
  'afterAgentResponse', 'afterAgentThought', 'beforeTabFileRead', 'afterTabFileEdit',
]);

export function resolveHookName(payload, argv = []) {
  const index = argv.indexOf('--event');
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  const fromArg = argv.find((value) => value.startsWith('--event='));
  if (fromArg) return fromArg.slice('--event='.length);
  if (payload && typeof payload === 'object') {
    return payload.hook_event_name || payload.hookEventName || payload.event || payload.eventName;
  }
  return undefined;
}

export function mapGenericHookEvent({ host, hostVersion, payload, eventName }) {
  const name = safeString(eventName, 64);
  if (!name || IGNORED.has(name)) return [];

  const sessionId = toSessionId(
    payload?.session_id ?? payload?.sessionId ?? payload?.conversation_id,
    fallbackSessionId(host, payload?.cwd || ''),
  );
  const cwdHint = safeString(
    typeof payload?.cwd === 'string' ? payload.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined,
    80,
  );
  const meta = {
    model: safeString(payload?.model, 80),
    permissionMode: safeString(payload?.permission_mode, 40),
    cwdHint,
  };
  const base = { host, hostVersion, sessionId };

  if (TOOL_EVENTS[name]) {
    const spec = TOOL_EVENTS[name];
    const toolName = safeString(spec.tool, 80) || safeString(payload?.tool_name ?? payload?.toolName, 80);
    return [makeEvent({
      ...base,
      eventType: spec.type,
      state: spec.state,
      metadata: {
        ...meta,
        toolName,
        toolStatus: spec.type === 'tool.end' ? 'ok' : spec.type === 'tool.fail' ? 'failed' : 'running',
        errorCode: spec.type === 'tool.fail' ? safeToken(payload?.error_code, 64) : undefined,
      },
    })];
  }

  if (SIMPLE_EVENTS[name]) {
    const spec = SIMPLE_EVENTS[name];
    // PRIVACY: never forward arbitrary host text (payload.reason is free-form on
    // some hosts). Only constants or known enum values may become a label.
    const enumLabel = safeEnum(payload?.source, SESSION_START_SOURCES)
      ?? safeEnum(payload?.reason, STOP_REASONS);
    return [makeEvent({
      ...base,
      eventType: spec.eventType,
      state: spec.state,
      metadata: {
        ...meta,
        label: enumLabel ?? name,
        agentName: safeToken(payload?.agent_type, 40),
      },
    })];
  }

  // Unknown/new host events are dropped rather than guessed.
  return [];
}
