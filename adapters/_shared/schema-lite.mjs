/**
 * HALOFLUX — minimal, dependency-free mirror of @haloflux/event-schema.
 *
 * This is a *fallback only*. The real contract lives in
 * `packages/event-schema/src/index.ts` (frozen v1) and is imported from
 * `packages/event-schema/dist/index.js` by `event-client.mjs`. The fallback
 * exists so a host hook can never break just because the workspace was not
 * built: an adapter that cannot validate still exits 0 and posts nothing.
 *
 * Keep this file in sync with the frozen schema (SCHEMA_VERSION 1).
 */

export const SCHEMA_VERSION = 1;

export const HOSTS = [
  'deepseek-harness', 'codex', 'cursor', 'claude-code', 'workbuddy', 'trae', 'generic', 'simulator',
];

export const AGENT_STATES = [
  'disconnected', 'connected', 'idle', 'running', 'tool', 'output',
  'waiting_approval', 'done', 'error', 'unknown',
];

export const EVENT_TYPES = [
  'host.connected', 'host.disconnected', 'session.start', 'session.end', 'session.switch',
  'session.heartbeat', 'task.received', 'run.start', 'run.end', 'tool.start', 'tool.end',
  'tool.fail', 'output.start', 'output.chunk', 'output.end', 'approval.request',
  'approval.resolve', 'error', 'state.snapshot',
];

export const EVENT_SOURCES = ['host-native', 'derived', 'simulated'];
export const CONFIDENCE_LEVELS = ['confirmed', 'inferred', 'unverified'];

export const EVENT_DEFAULT_STATE = {
  'host.connected': 'connected',
  'host.disconnected': 'disconnected',
  'session.start': 'connected',
  'session.end': 'disconnected',
  'session.switch': 'connected',
  'session.heartbeat': 'unknown',
  'task.received': 'running',
  'run.start': 'running',
  'run.end': 'idle',
  'tool.start': 'tool',
  'tool.end': 'running',
  'tool.fail': 'running',
  'output.start': 'output',
  'output.chunk': 'output',
  'output.end': 'running',
  'approval.request': 'waiting_approval',
  'approval.resolve': 'running',
  error: 'error',
  'state.snapshot': 'unknown',
};

export const METADATA_KEYS = [
  'toolName', 'toolCategory', 'toolStatus', 'toolCallId', 'runId', 'step', 'turn', 'label', 'errorCode',
  'durationMs', 'tokenCount', 'tokensPerSecond', 'contextUsed', 'contextLimit', 'model',
  'projectName', 'sessionTitle', 'agentName', 'permissionMode', 'approvalKind',
  'queueDepth', 'latencyMs', 'cwdHint', 'custom',
];

const STRING_LIMITS = {
  toolName: 80, toolCategory: 40, toolStatus: 16, toolCallId: 64, runId: 64, label: 120, errorCode: 64,
  model: 80, projectName: 120, sessionTitle: 160, agentName: 80,
  permissionMode: 40, approvalKind: 40, cwdHint: 80,
};
const NUMBER_KEYS = [
  'step', 'turn', 'durationMs', 'tokenCount', 'tokensPerSecond',
  'contextUsed', 'contextLimit', 'queueDepth', 'latencyMs',
];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'then']);
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

let counter = 0;

export function createEvent(input) {
  counter = (counter + 1) % 0xffff;
  const eventId = input.eventId
    ?? `${input.host}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId,
    timestamp: input.timestamp ?? Date.now(),
    host: input.host,
    hostVersion: input.hostVersion ?? '',
    sessionId: input.sessionId,
    eventType: input.eventType,
    state: input.state ?? EVENT_DEFAULT_STATE[input.eventType],
    source: input.source ?? 'host-native',
    confidence: input.confidence ?? 'confirmed',
    metadata: input.metadata ?? {},
  };
}

function byteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function validateEvent(input) {
  const errors = [];
  const push = (path, code, message) => errors.push({ path, code, message });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path: '$', code: 'not_object', message: 'event must be a JSON object' }] };
  }
  if (input.schemaVersion !== SCHEMA_VERSION) push('schemaVersion', 'unsupported_version', 'expected 1');
  if (typeof input.eventId !== 'string' || !EVENT_ID_RE.test(input.eventId)) push('eventId', 'bad_event_id', 'bad id');
  if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp) || input.timestamp <= 0) push('timestamp', 'bad_timestamp', 'bad timestamp');
  if (typeof input.host !== 'string' || !HOSTS.includes(input.host)) push('host', 'bad_host', 'bad host');
  if (typeof input.hostVersion !== 'string' || input.hostVersion.length > 64) push('hostVersion', 'bad_host_version', 'bad host version');
  if (typeof input.sessionId !== 'string' || !SESSION_ID_RE.test(input.sessionId)) push('sessionId', 'bad_session_id', 'bad session id');
  if (typeof input.eventType !== 'string' || !EVENT_TYPES.includes(input.eventType)) push('eventType', 'bad_event_type', 'bad event type');
  if (typeof input.state !== 'string' || !AGENT_STATES.includes(input.state)) push('state', 'bad_state', 'bad state');
  if (typeof input.source !== 'string' || !EVENT_SOURCES.includes(input.source)) push('source', 'bad_source', 'bad source');
  if (typeof input.confidence !== 'string' || !CONFIDENCE_LEVELS.includes(input.confidence)) push('confidence', 'bad_confidence', 'bad confidence');

  if (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
    push('metadata', 'bad_metadata', 'metadata must be a JSON object');
  } else {
    for (const key of Object.keys(input.metadata)) {
      if (FORBIDDEN_KEYS.has(key)) { push(`metadata.${key}`, 'forbidden_key', 'forbidden'); continue; }
      if (!METADATA_KEYS.includes(key)) { push(`metadata.${key}`, 'unknown_metadata_key', 'allowlist only'); continue; }
      const value = input.metadata[key];
      if (value === undefined) continue;
      if (key in STRING_LIMITS) {
        if (typeof value !== 'string' || value.length > STRING_LIMITS[key]) push(`metadata.${key}`, 'bad_string', 'bad string');
      } else if (key === 'toolStatus') {
        if (!['running', 'ok', 'failed', 'cancelled'].includes(value)) push(`metadata.${key}`, 'bad_tool_status', 'bad status');
      } else if (NUMBER_KEYS.includes(key)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) push(`metadata.${key}`, 'bad_number', 'bad number');
      } else if (key === 'custom') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          push('metadata.custom', 'bad_custom', 'custom must be an object');
        } else {
          const entries = Object.entries(value);
          if (entries.length > 16) push('metadata.custom', 'custom_too_many_keys', 'max 16');
          for (const [k, v] of entries) {
            const ok = v === null || typeof v === 'string' || typeof v === 'boolean'
              || (typeof v === 'number' && Number.isFinite(v));
            if (FORBIDDEN_KEYS.has(k) || k.length > 40) push(`metadata.custom.${k}`, 'bad_custom_key', 'bad key');
            else if (!ok) push(`metadata.custom.${k}`, 'bad_custom_value', 'bad value');
            else if (typeof v === 'string' && v.length > 200) push(`metadata.custom.${k}`, 'bad_custom_value', 'too long');
          }
          if (byteLength(value) > 1024) push('metadata.custom', 'custom_too_large', 'max 1KB');
        }
      }
    }
    if (byteLength(input.metadata) > 4096) push('metadata', 'metadata_too_large', 'max 4KB');
  }
  if (byteLength(input) > 8192) push('$', 'event_too_large', 'max 8KB');
  return errors.length ? { ok: false, errors } : { ok: true, value: input };
}
