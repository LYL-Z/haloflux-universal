/**
 * HALOFLUX Universal Agent Visualizer — unified event schema (schemaVersion 1).
 *
 * One normalized event shape for every host adapter. The renderer never sees a
 * host-native payload: adapters map their host events onto this schema, the
 * bridge validates and orders them, the session manager derives agent state.
 *
 * Privacy by construction: `metadata` is an allowlist. Prompts, chat text, file
 * contents, tool arguments/results, API keys and credentials cannot be carried
 * in an event, because unknown metadata keys are rejected by the validator.
 */

export const SCHEMA_VERSION = 1 as const;

/** Hosts with first-class adapters. `generic` covers documented JSONL/MCP hosts. */
export const HOSTS = [
  'deepseek-harness',
  'codex',
  'cursor',
  'claude-code',
  'workbuddy',
  'trae',
  'generic',
  'simulator',
] as const;
export type HostId = (typeof HOSTS)[number];

/** The only states the visual engine may render as *the agent's* state. */
export const AGENT_STATES = [
  'disconnected',
  'connected',
  'idle',
  'running',
  'tool',
  'output',
  'waiting_approval',
  'done',
  'error',
  'unknown',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * Normalized event types. Semantics, not host vocabulary:
 * `task.received` = the user submitted work, `run.start` = the agent loop began
 * a turn, `output.*` = assistant text streaming, `tool.*` = a tool invocation,
 * `approval.*` = the host is blocked on a human decision.
 */
export const EVENT_TYPES = [
  'host.connected',
  'host.disconnected',
  'session.start',
  'session.end',
  'session.switch',
  'session.heartbeat',
  'task.received',
  'run.start',
  'run.end',
  'tool.start',
  'tool.end',
  'tool.fail',
  'output.start',
  'output.chunk',
  'output.end',
  'approval.request',
  'approval.resolve',
  'error',
  'state.snapshot',
] as const;
export type HalofluxEventType = (typeof EVENT_TYPES)[number];

/** Where the claim in `state` comes from. Never collapse these three. */
export const EVENT_SOURCES = ['host-native', 'derived', 'simulated'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** How sure the producer is about `state` for *this* event. */
export const CONFIDENCE_LEVELS = ['confirmed', 'inferred', 'unverified'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Default state carried by each event type (adapters may override). */
export const EVENT_DEFAULT_STATE: Record<HalofluxEventType, AgentState> = {
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

/**
 * Allowed metadata keys. Everything here is small, non-sensitive and optional.
 * `tokenCount` means assistant output tokens for the step, not prompt content.
 */
export const METADATA_KEYS = [
  'toolName',
  'toolCategory',
  'toolStatus',
  'toolCallId',
  'runId',
  'step',
  'turn',
  'label',
  'errorCode',
  'durationMs',
  'tokenCount',
  'tokensPerSecond',
  'contextUsed',
  'contextLimit',
  'model',
  'projectName',
  'sessionTitle',
  'agentName',
  'permissionMode',
  'approvalKind',
  'queueDepth',
  'latencyMs',
  'cwdHint',
  'custom',
] as const;
export type MetadataKey = (typeof METADATA_KEYS)[number];

export interface EventCustomMetadata {
  [key: string]: string | number | boolean | null;
}

export type EventMetadata = {
  toolName?: string;
  toolCategory?: string;
  toolStatus?: 'running' | 'ok' | 'failed' | 'cancelled';
  /** Host-issued tool invocation id, when the host exposes one. Optional. */
  toolCallId?: string;
  /** Host-issued run/turn correlation id, when exposed. Optional. */
  runId?: string;
  step?: number;
  turn?: number;
  label?: string;
  errorCode?: string;
  durationMs?: number;
  tokenCount?: number;
  tokensPerSecond?: number;
  contextUsed?: number;
  contextLimit?: number;
  model?: string;
  projectName?: string;
  sessionTitle?: string;
  agentName?: string;
  permissionMode?: string;
  approvalKind?: string;
  queueDepth?: number;
  latencyMs?: number;
  /** Basename or hashed hint only — never a full path or file content. */
  cwdHint?: string;
  custom?: EventCustomMetadata;
};

export interface HalofluxEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  eventId: string;
  /** Unix epoch milliseconds, produced by the adapter. */
  timestamp: number;
  host: HostId;
  hostVersion: string;
  sessionId: string;
  eventType: HalofluxEventType;
  state: AgentState;
  source: EventSource;
  confidence: Confidence;
  metadata: EventMetadata;
}

export const MAX_EVENT_BYTES = 8 * 1024;
export const MAX_METADATA_BYTES = 4096;
export const MAX_CUSTOM_BYTES = 1024;
export const MAX_BATCH = 100;

const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const HOST_VERSION_MAX = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'then']);

const STRING_FIELDS: Partial<Record<MetadataKey, number>> = {
  toolName: 80,
  toolCategory: 40,
  toolCallId: 64,
  runId: 64,
  label: 120,
  errorCode: 64,
  model: 80,
  projectName: 120,
  sessionTitle: 160,
  agentName: 80,
  permissionMode: 40,
  approvalKind: 40,
  cwdHint: 80,
};

const NUMBER_FIELDS: MetadataKey[] = [
  'step', 'turn', 'durationMs', 'tokenCount', 'tokensPerSecond',
  'contextUsed', 'contextLimit', 'queueDepth', 'latencyMs',
];

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: HalofluxEvent }
  | { ok: false; errors: ValidationIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** UTF-8 byte length without DOM/Node globals (the schema is runtime-neutral). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function byteLength(value: unknown): number {
  try {
    return utf8Length(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function push(errors: ValidationIssue[], path: string, code: string, message: string): void {
  errors.push({ path, code, message });
}

/** Validate an unknown payload as a v1 event. Strict: unknown metadata keys fail. */
export function validateEvent(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'not_object', message: 'event must be a JSON object' }] };
  }

  if (input.schemaVersion !== SCHEMA_VERSION) {
    push(errors, 'schemaVersion', 'unsupported_version', `expected ${SCHEMA_VERSION}`);
  }
  if (typeof input.eventId !== 'string' || !EVENT_ID_RE.test(input.eventId)) {
    push(errors, 'eventId', 'bad_event_id', 'eventId must match [A-Za-z0-9_-]{8,128}');
  }
  if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp) || input.timestamp <= 0) {
    push(errors, 'timestamp', 'bad_timestamp', 'timestamp must be a positive epoch-ms number');
  }
  if (typeof input.host !== 'string' || !(HOSTS as readonly string[]).includes(input.host)) {
    push(errors, 'host', 'bad_host', `host must be one of ${HOSTS.join(', ')}`);
  }
  if (typeof input.hostVersion !== 'string' || input.hostVersion.length > HOST_VERSION_MAX) {
    push(errors, 'hostVersion', 'bad_host_version', `hostVersion must be a string <= ${HOST_VERSION_MAX} chars`);
  }
  if (typeof input.sessionId !== 'string' || !SESSION_ID_RE.test(input.sessionId)) {
    push(errors, 'sessionId', 'bad_session_id', 'sessionId must match [A-Za-z0-9._:@-]{1,128}');
  }
  if (typeof input.eventType !== 'string' || !(EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    push(errors, 'eventType', 'bad_event_type', `eventType must be one of ${EVENT_TYPES.join(', ')}`);
  }
  if (typeof input.state !== 'string' || !(AGENT_STATES as readonly string[]).includes(input.state)) {
    push(errors, 'state', 'bad_state', `state must be one of ${AGENT_STATES.join(', ')}`);
  }
  if (typeof input.source !== 'string' || !(EVENT_SOURCES as readonly string[]).includes(input.source)) {
    push(errors, 'source', 'bad_source', `source must be one of ${EVENT_SOURCES.join(', ')}`);
  }
  if (typeof input.confidence !== 'string' || !(CONFIDENCE_LEVELS as readonly string[]).includes(input.confidence)) {
    push(errors, 'confidence', 'bad_confidence', `confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if (!isPlainObject(input.metadata)) {
    push(errors, 'metadata', 'bad_metadata', 'metadata must be a JSON object');
  } else {
    validateMetadata(input.metadata, errors);
  }

  if (byteLength(input) > MAX_EVENT_BYTES) {
    push(errors, '$', 'event_too_large', `serialized event must be <= ${MAX_EVENT_BYTES} bytes`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as HalofluxEvent };
}

function validateMetadata(metadata: Record<string, unknown>, errors: ValidationIssue[]): void {
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_KEYS.has(key)) {
      push(errors, `metadata.${key}`, 'forbidden_key', 'prototype-polluting key');
      continue;
    }
    if (!(METADATA_KEYS as readonly string[]).includes(key)) {
      push(errors, `metadata.${key}`, 'unknown_metadata_key', 'metadata keys are allowlisted; prompts/content are not representable');
      continue;
    }
    const value = metadata[key];
    if (value === undefined) continue;
    const maxLen = STRING_FIELDS[key as MetadataKey];
    if (maxLen !== undefined) {
      if (typeof value !== 'string' || value.length > maxLen) {
        push(errors, `metadata.${key}`, 'bad_string', `must be a string <= ${maxLen} chars`);
      }
      continue;
    }
    if (key === 'toolStatus') {
      if (typeof value !== 'string' || !['running', 'ok', 'failed', 'cancelled'].includes(value)) {
        push(errors, `metadata.${key}`, 'bad_tool_status', 'must be running|ok|failed|cancelled');
      }
      continue;
    }
    if ((NUMBER_FIELDS as string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        push(errors, `metadata.${key}`, 'bad_number', 'must be a finite number >= 0');
      }
      continue;
    }
    if (key === 'custom') {
      validateCustom(value, errors);
    }
  }
  if (byteLength(metadata) > MAX_METADATA_BYTES) {
    push(errors, 'metadata', 'metadata_too_large', `metadata must be <= ${MAX_METADATA_BYTES} bytes`);
  }
}

function validateCustom(value: unknown, errors: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    push(errors, 'metadata.custom', 'bad_custom', 'custom must be a flat JSON object');
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 16) {
    push(errors, 'metadata.custom', 'custom_too_many_keys', 'custom supports at most 16 keys');
    return;
  }
  for (const [k, v] of entries) {
    if (FORBIDDEN_KEYS.has(k) || k.length > 40) {
      push(errors, `metadata.custom.${k}`, 'bad_custom_key', 'custom keys must be <= 40 chars and not prototype keys');
      continue;
    }
    const ok = v === null || typeof v === 'string' || typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v));
    if (!ok) {
      push(errors, `metadata.custom.${k}`, 'bad_custom_value', 'custom values must be string|number|boolean|null');
    } else if (typeof v === 'string' && v.length > 200) {
      push(errors, `metadata.custom.${k}`, 'bad_custom_value', 'custom strings <= 200 chars');
    }
  }
  if (byteLength(value) > MAX_CUSTOM_BYTES) {
    push(errors, 'metadata.custom', 'custom_too_large', `custom must be <= ${MAX_CUSTOM_BYTES} bytes`);
  }
}

/** True when a payload is an accepted v1 event. */
export function isHalofluxEvent(input: unknown): input is HalofluxEvent {
  return validateEvent(input).ok;
}

export interface CreateEventInput {
  host: HostId;
  sessionId: string;
  eventType: HalofluxEventType;
  state?: AgentState;
  source?: EventSource;
  confidence?: Confidence;
  hostVersion?: string;
  timestamp?: number;
  eventId?: string;
  metadata?: EventMetadata;
}

let counter = 0;

/** Build a valid event with defaults. Adapters should prefer this constructor. */
export function createEvent(input: CreateEventInput): HalofluxEvent {
  counter = (counter + 1) % 0xffff;
  const eventId = input.eventId ?? `${input.host}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

/** Parse a JSON string, returning `undefined` on any syntax or size failure. */
export function parseEventJson(text: string): unknown {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  if (text.length > MAX_EVENT_BYTES * 2) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Accept either one event or `{events: [...]}`; returns a flat array or throws. */
export function parseBatch(input: unknown): HalofluxEvent[] {
  let candidates: unknown[];
  if (isPlainObject(input) && Array.isArray(input.events)) candidates = input.events;
  else if (Array.isArray(input)) candidates = input;
  else candidates = [input];

  if (candidates.length === 0) throw new Error('empty batch');
  if (candidates.length > MAX_BATCH) throw new Error(`batch exceeds ${MAX_BATCH} events`);

  const events: HalofluxEvent[] = [];
  const failures: ValidationIssue[] = [];
  candidates.forEach((candidate, index) => {
    const result = validateEvent(candidate);
    if (result.ok) events.push(result.value);
    else failures.push(...result.errors.map((e) => ({ ...e, path: `[${index}]${e.path === '$' ? '' : '.'}${e.path}` })));
  });
  if (failures.length > 0) {
    const error = new Error(`invalid event batch: ${failures.length} issue(s)`) as Error & { issues?: ValidationIssue[] };
    error.issues = failures;
    throw error;
  }
  return events;
}

/** Deterministic ordering key: timestamp, then eventId, so replays converge. */
export function compareEvents(a: HalofluxEvent, b: HalofluxEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}
