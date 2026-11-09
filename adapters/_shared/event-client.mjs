/**
 * HALOFLUX — shared adapter runtime (host-agnostic).
 *
 * Every host adapter is a **leaf process**: it receives a host payload, maps it
 * onto the frozen v1 event schema, POSTs it to the loopback bridge and exits 0.
 * It must never write to the host's stdout protocol, never block a host
 * decision, and never carry prompt text, file contents or tool arguments.
 *
 * Contract: docs/architecture.md §4 (event protocol), §6 (HTTP API), §10
 * (security invariants). The authoritative schema implementation is
 * `packages/event-schema` (imported below); `schema-lite.mjs` is a fallback so
 * a missing build can never break a host hook.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let schema;
try {
  schema = await import('../../packages/event-schema/dist/index.js');
} catch {
  schema = await import('./schema-lite.mjs');
}
export const { createEvent, validateEvent, MAX_EVENT_BYTES, EVENT_TYPES, AGENT_STATES, HOSTS } = schema;

export const ADAPTER_VERSION = '0.1.0';
export const DEFAULT_PORT = 17817;
export const DEFAULT_TIMEOUT_MS = 1500;
const MAX_STDIN_BYTES = 262144;

/** `%LOCALAPPDATA%\HALOFLUX` unless HALOFLUX_HOME overrides it. */
export function resolveHalofluxHome() {
  if (process.env.HALOFLUX_HOME) return process.env.HALOFLUX_HOME;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'HALOFLUX');
}

export function resolveTokenPath() {
  return process.env.HALOFLUX_TOKEN_FILE || path.join(resolveHalofluxHome(), 'token');
}

/**
 * Read the bridge token from $HALOFLUX_TOKEN or the token file.
 * Returns '' when unavailable — callers then skip the POST silently.
 * The token is never logged and never leaves this process except as an
 * Authorization header to 127.0.0.1.
 */
export function readToken() {
  const fromEnv = (process.env.HALOFLUX_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const tokenPath = resolveTokenPath();
  try {
    if (!existsSync(tokenPath)) return '';
    const token = readFileSync(tokenPath, 'utf8').trim();
    return /^[A-Za-z0-9._~+/-]{16,512}$/.test(token) ? token : '';
  } catch {
    return '';
  }
}

export function resolveBridgeUrl() {
  const raw = (process.env.HALOFLUX_BRIDGE_URL || `http://127.0.0.1:${DEFAULT_PORT}`).trim();
  return raw.replace(/\/+$/, '');
}

export function resolveTimeoutMs() {
  const raw = Number(process.env.HALOFLUX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : DEFAULT_TIMEOUT_MS;
}

export function debug(...args) {
  if (process.env.HALOFLUX_DEBUG === '1') {
    try {
      process.stderr.write(`[haloflux] ${args.map(String).join(' ')}\n`);
    } catch {
      /* never let logging break a hook */
    }
  }
}

/** Strip NUL/control characters and clamp a string to the schema limit. */
export function safeString(value, max = 120) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

/** Only finite, non-negative numbers are representable in metadata. */
export function safeNumber(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Privacy helper: only accept a short identifier-shaped token from a host
 * payload (tool names, agent types, enum values). Anything that looks like
 * prose, a path or a prompt is dropped instead of being forwarded.
 */
export function safeToken(value, max = 40) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return /^[A-Za-z0-9_.:@/\\-]+$/.test(trimmed) ? trimmed : undefined;
}

/** Privacy helper: forward `value` only when it is one of `allowed`. */
export function safeEnum(value, allowed, fallback = undefined) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * Keep only allowlisted metadata keys, drop empty values, clamp strings.
 * This is the privacy boundary: whatever the host payload contains, only the
 * keys below can ever leave the adapter.
 */
const STRING_KEYS = {
  toolName: 80, toolCategory: 40, toolStatus: 16, toolCallId: 64, runId: 64, label: 120, errorCode: 64,
  model: 80, projectName: 120, sessionTitle: 160, agentName: 80,
  permissionMode: 40, approvalKind: 40, cwdHint: 80,
};
const NUMBER_KEYS = new Set([
  'step', 'turn', 'durationMs', 'tokenCount', 'tokensPerSecond',
  'contextUsed', 'contextLimit', 'queueDepth', 'latencyMs',
]);

export function sanitizeMetadata(metadata) {
  const out = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
  for (const [key, raw] of Object.entries(metadata)) {
    if (raw === undefined || raw === null) continue;
    if (key in STRING_KEYS) {
      const value = key === 'toolStatus' && ['running', 'ok', 'failed', 'cancelled'].includes(raw)
        ? raw
        : safeString(raw, STRING_KEYS[key]);
      if (value !== undefined) out[key] = value;
    } else if (NUMBER_KEYS.has(key)) {
      const value = safeNumber(raw);
      if (value !== undefined) out[key] = value;
    } else if (key === 'custom' && typeof raw === 'object' && !Array.isArray(raw)) {
      const custom = {};
      for (const [k, v] of Object.entries(raw).slice(0, 16)) {
        if (typeof k !== 'string' || k.length === 0 || k.length > 40) continue;
        if (['__proto__', 'constructor', 'prototype', 'then'].includes(k)) continue;
        if (typeof v === 'string') custom[k] = safeString(v, 200) ?? '';
        else if (typeof v === 'number' && Number.isFinite(v)) custom[k] = v;
        else if (typeof v === 'boolean' || v === null) custom[k] = v;
      }
      if (Object.keys(custom).length) out.custom = custom;
    }
  }
  return out;
}

const SAFE_SESSION_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * Use the host's session id when it already fits the schema charset; otherwise
 * hash it (128-char safe charset, no reversible path leak).
 */
export function toSessionId(raw, fallback) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (SAFE_SESSION_RE.test(trimmed)) return trimmed;
    if (trimmed.length > 0) {
      return `h-${crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 32)}`;
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return `n-${Math.trunc(raw)}`;
  return fallback;
}

/** Deterministic session id when the host payload has none (e.g. a bare ping). */
export function fallbackSessionId(host, seed = '') {
  const material = `${os.hostname()}|${process.env.USERNAME || ''}|${seed}`;
  return `anon-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

export function hostVersionFile() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '.host-versions.json');
}

/** Cached host version captured at install time (avoids spawning the host per hook). */
export function readHostVersion(host) {
  if (process.env.HALOFLUX_HOST_VERSION) return process.env.HALOFLUX_HOST_VERSION.slice(0, 64);
  try {
    const file = hostVersionFile();
    if (!existsSync(file)) return '';
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const value = data && data[host] && data[host].version;
    return typeof value === 'string' ? value.slice(0, 64) : '';
  } catch {
    return '';
  }
}

/** Used by installers (and the doctor) to persist the detected host version. */
export function writeHostVersion(host, version) {
  try {
    const file = hostVersionFile();
    let data = {};
    if (existsSync(file)) {
      try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { data = {}; }
    }
    data[host] = { version: String(version || '').slice(0, 64), detectedAt: new Date().toISOString() };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Build + validate one event; returns undefined when the payload is invalid. */
export function makeEvent({
  host, hostVersion, sessionId, eventType, state, source, confidence, metadata, timestamp,
}) {
  const candidate = createEvent({
    host,
    hostVersion: safeString(hostVersion, 64) ?? '',
    sessionId,
    eventType,
    ...(state ? { state } : {}),
    source: source ?? 'host-native',
    confidence: confidence ?? 'confirmed',
    metadata: sanitizeMetadata(metadata),
    ...(timestamp ? { timestamp } : {}),
  });
  const result = validateEvent(candidate);
  if (result.ok) return candidate;
  debug('event rejected by schema', JSON.stringify(result.errors));
  return undefined;
}

/** Read stdin as UTF-8 text; resolves '' when the host closes it or times out. */
export function readStdinText({ timeoutMs = 1200, maxBytes = MAX_STDIN_BYTES } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), Math.max(50, timeoutMs));
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
      });
      process.stdin.on('end', () => finish(chunks.join('')));
      process.stdin.on('error', () => finish(''));
      process.stdin.resume();
    } catch {
      finish('');
    }
  });
}

export function parseJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

/**
 * Interpret a JSONL stream: returns every line that parses.
 * Used by the generic adapter and by read-only session watchers.
 */
export function parseJsonLines(raw) {
  const out = [];
  if (typeof raw !== 'string') return out;
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed.replace(/^\uFEFF/, ''))); } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * POST one event or a batch. Never throws; never logs the token.
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
export async function postEvents(events, {
  timeoutMs = resolveTimeoutMs(),
  bridgeUrl = resolveBridgeUrl(),
  token = readToken(),
} = {}) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (list.length === 0) return { ok: false, reason: 'no-events' };
  if (!token) return { ok: false, reason: 'no-token' };

  const valid = [];
  for (const event of list) {
    const result = validateEvent(event);
    if (result.ok) valid.push(event);
    else debug('dropping invalid event', JSON.stringify(result.errors));
  }
  if (valid.length === 0) return { ok: false, reason: 'schema' };

  // The bridge accepts at most 100 events per request. A long trace can easily
  // exceed that, so every adapter chunks instead of letting the whole batch 400.
  const MAX_BATCH = 100;
  let accepted = 0;
  let batches = 0;
  try {
    for (let offset = 0; offset < valid.length; offset += MAX_BATCH) {
      const chunk = valid.slice(offset, offset + MAX_BATCH);
      const body = JSON.stringify(chunk.length === 1 ? chunk[0] : { events: chunk });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
      try {
        const response = await fetch(`${bridgeUrl}/v1/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body,
          signal: controller.signal,
        });
        debug('bridge responded', response.status);
        if (!response.ok) {
          return { ok: false, status: response.status, accepted, batches };
        }
        const payload = await response.json().catch(() => null);
        accepted += Number(payload && payload.accepted) || chunk.length;
        batches += 1;
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: true, status: 202, accepted, batches };
  } catch (error) {
    debug('bridge post failed', error && (error.code || error.name || error.message));
    return { ok: false, reason: 'unreachable', accepted, batches };
  }
}

/** Best-effort bridge liveness check (used by --status and the doctor). */
export async function bridgeHealth({ timeoutMs = 500, bridgeUrl = resolveBridgeUrl() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${bridgeUrl}/v1/health`, { signal: controller.signal });
    if (!response.ok) return { online: false, status: response.status };
    const data = await response.json().catch(() => ({}));
    return { online: true, status: response.status, name: data.name, version: data.version };
  } catch {
    return { online: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared entry point for *hook* adapters.
 *
 * `map(payload, argv)` returns zero or more events. Everything is wrapped in
 * try/catch and the process always exits 0 — a hook must never fail a host.
 * Stdout is only written when `--print-event` is passed explicitly (debugging).
 */
export async function runHookAdapter({ host, map, argv = process.argv.slice(2) }) {
  const printEvent = argv.includes('--print-event');
  try {
    const raw = await readStdinText({ timeoutMs: Number(process.env.HALOFLUX_STDIN_TIMEOUT_MS) || 1200 });
    const payload = parseJson(raw);
    const events = (await map(payload, argv)) || [];
    const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
    if (printEvent) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    await postEvents(list);
  } catch (error) {
    debug('hook adapter error', error && (error.stack || error.message));
  } finally {
    // Exit immediately: hooks are short-lived and the host must not wait on us.
    process.exit(0);
  }
}

/** Map an event-type default state without importing the whole table twice. */
export function defaultState(eventType) {
  return createEvent({ host: 'generic', sessionId: 'tmp', eventType }).state;
}
