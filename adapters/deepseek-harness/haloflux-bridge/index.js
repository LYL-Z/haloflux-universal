/**
 * HALOFLUX for DeepSeek Harness — Host-side event bridge (Cordis bundle).
 *
 * Subscribes to the real Harness session firehose
 * (`session/created`, `session/event`, `session/disposed`, `agent/error`) and
 * forwards a *normalized, metadata-only* HALOFLUX event v1 to the loopback
 * Event Bridge (`http://127.0.0.1:17817/v1/events`, host `deepseek-harness`).
 *
 * Hard rules (see docs/architecture.md §4/§10):
 *  - Never read or transmit prompt text, assistant text, tool arguments,
 *    tool results, file contents, credentials or API keys. Only the allowlisted
 *    metadata keys are populated, and only from small scalar fields.
 *  - Never throw into the Host: every listener body is try/catch-contained;
 *    a missing bridge, token, or probe file is silent.
 *  - Nothing here decides anything: the bridge is a leaf observer. Failure of
 *    this plugin must not change an agent turn.
 *  - The whole plugin is zero-dependency (Node built-ins only) so a `link:`
 *    installed bundle resolves in the Host process without installing peers.
 *
 * Settings / disable switches (highest precedence last):
 *  1. bundle entry config (its cordis.patch.yml `config:` block)
 *  2. `local.config.json` next to this file (developer override, gitignored)
 *  3. environment: HALOFLUX_DSH_ENABLED=0, HALOFLUX_BRIDGE_URL,
 *     HALOFLUX_TOKEN / HALOFLUX_TOKEN_FILE, HALOFLUX_HOME
 *  4. live product settings: `%LOCALAPPDATA%\HALOFLUX\settings.json`
 *     `{ "hosts": { "deepseek-harness": { "enabled": false } } }` (2 s cache)
 *
 * @module dsh-haloflux-bridge
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const name = 'haloflux-bridge';
export const HOST = 'deepseek-harness';
export const SCHEMA_VERSION = 1;
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:17817';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PROBE_LOG_MAX_BYTES = 512 * 1024;
const TOKEN_CACHE_MS = 5000;
const SETTINGS_CACHE_MS = 2000;
const HOST_VERSION_FALLBACK = '0.2.1-rc.5';

/** Default state per event type (mirrors packages/event-schema/src/index.ts). */
const EVENT_DEFAULT_STATE = {
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

const STRING_LIMITS = {
  toolName: 80,
  toolCategory: 40,
  toolStatus: 16,
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

const NUMBER_KEYS = new Set([
  'step', 'turn', 'durationMs', 'tokenCount', 'tokensPerSecond',
  'contextUsed', 'contextLimit', 'queueDepth', 'latencyMs',
]);

const DEFAULTS = {
  enabled: true,
  bridgeUrl: DEFAULT_BRIDGE_URL,
  /** Dev-only inline token (prefer the token file). Never commit a real token. */
  token: '',
  /** '' => %LOCALAPPDATA%\\HALOFLUX\\token */
  tokenFile: '',
  /** 'auto' => os.tmpdir()/haloflux-dsh-bridge-events.jsonl ; 'off' disables. */
  probeLog: 'auto',
  heartbeatMs: 30000,
  outputChunkThrottleMs: 1000,
  maxEventsPerSecond: 20,
  queueLimit: 256,
  timeoutMs: 1500,
  includeToolNames: true,
  hostVersion: '',
};

let eventCounter = 0;

/** Clip a string for the schema allowlist (never throws on non-strings). */
function clip(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= max ? text : text.slice(0, max);
}

function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** Session ids must match [A-Za-z0-9._:@-]{1,128}. */
export function normalizeSessionId(raw) {
  const text = typeof raw === 'string' && raw ? raw : 'unknown';
  const safe = text.replace(/[^A-Za-z0-9._:@-]/g, '-').slice(0, 128);
  return safe || 'unknown';
}

function hashText(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function eventIdFor(sessionId, eventType, seq) {
  eventCounter = (eventCounter + 1) % 0xffffff;
  const suffix = (seq === undefined || seq === null ? randomUUID().replace(/-/g, '').slice(0, 8) : String(seq).replace(/[^0-9a-z]/gi, ''))
    || 'x';
  const slug = String(eventType).replace(/[^a-z]/g, '').slice(0, 12) || 'event';
  return `dsh-${hashText(sessionId)}-${suffix.slice(0, 12)}-${eventCounter.toString(36)}-${slug}`;
}

/** Tool name -> coarse category (no arguments are inspected). */
export function toolCategory(toolName) {
  const n = String(toolName || '').toLowerCase();
  if (!n) return undefined;
  if (/(bash|pwsh|shell|command|terminal|exec)/.test(n)) return 'shell';
  if (/(read|write|edit|apply_patch|str_replace|file|fs|glob|grep)/.test(n)) return 'file';
  if (/(web|fetch|search|browser)/.test(n)) return 'web';
  if (/(subagent|agent|team|task)/.test(n)) return 'agent';
  if (/(workflow|plan|todo|goal)/.test(n)) return 'workflow';
  if (/(cordis|plugin|skill|mcp|job|schedule)/.test(n)) return 'platform';
  return 'other';
}

/** Build a valid HALOFLUX event object with the allowlisted metadata only. */
export function buildEvent({
  sessionId,
  eventType,
  state,
  source = 'host-native',
  confidence = 'confirmed',
  timestamp = Date.now(),
  seq,
  hostVersion = '',
  metadata = {},
}) {
  const safeSessionId = normalizeSessionId(sessionId);
  const safeMeta = {};
  for (const [key, raw] of Object.entries(metadata || {})) {
    if (raw === undefined || raw === null) continue;
    const limit = STRING_LIMITS[key];
    if (limit !== undefined) {
      const value = clip(raw, limit);
      if (value !== undefined) safeMeta[key] = value;
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      const value = num(raw);
      if (value !== undefined) safeMeta[key] = value;
      continue;
    }
    // toolStatus is the only enumerated field we emit.
    if (key === 'toolStatus' && ['running', 'ok', 'failed', 'cancelled'].includes(raw)) {
      safeMeta[key] = raw;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: eventIdFor(safeSessionId, eventType, seq),
    timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    host: HOST,
    hostVersion: clip(hostVersion, 64) || '',
    sessionId: safeSessionId,
    eventType,
    state: state || EVENT_DEFAULT_STATE[eventType] || 'unknown',
    source,
    confidence,
    metadata: safeMeta,
  };
}

/** Read the optional developer override next to index.js. */
function readLocalConfig(dir = PACKAGE_DIR) {
  try {
    const raw = readFileSync(join(dir, 'local.config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Resolve effective config: defaults < entry < local override < environment. */
export function resolveConfig(entryConfig, env = process.env, localConfig) {
  const local = localConfig === undefined ? readLocalConfig() : (localConfig || {});
  const merged = { ...DEFAULTS, ...(entryConfig || {}), ...local };
  if (env.HALOFLUX_DSH_ENABLED === '0' || env.HALOFLUX_DSH_ENABLED === 'false') merged.enabled = false;
  if (typeof env.HALOFLUX_DSH_ENABLED === 'string' && /^(1|true)$/i.test(env.HALOFLUX_DSH_ENABLED)) merged.enabled = true;
  if (env.HALOFLUX_BRIDGE_URL) merged.bridgeUrl = env.HALOFLUX_BRIDGE_URL;
  if (env.HALOFLUX_TOKEN) merged.token = env.HALOFLUX_TOKEN;
  if (env.HALOFLUX_TOKEN_FILE) merged.tokenFile = env.HALOFLUX_TOKEN_FILE;
  if (env.DSH_VERSION) merged.hostVersion = env.DSH_VERSION;
  if (!merged.hostVersion) merged.hostVersion = HOST_VERSION_FALLBACK;
  merged.bridgeUrl = String(merged.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
  merged.heartbeatMs = Math.max(0, num(merged.heartbeatMs) ?? 0);
  merged.outputChunkThrottleMs = Math.max(0, num(merged.outputChunkThrottleMs) ?? 0);
  merged.maxEventsPerSecond = Math.max(1, num(merged.maxEventsPerSecond) ?? 1);
  merged.queueLimit = Math.max(1, num(merged.queueLimit) ?? 1);
  merged.timeoutMs = Math.max(100, num(merged.timeoutMs) ?? 1500);
  return merged;
}

function halofluxHome(env = process.env) {
  if (env.HALOFLUX_HOME) return env.HALOFLUX_HOME;
  const local = env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
  return join(local, 'HALOFLUX');
}

function resolveProbePath(cfg) {
  const raw = cfg.probeLog;
  if (raw === 'off' || raw === false) return undefined;
  if (typeof raw === 'string' && raw.trim() && raw !== 'auto') return raw.trim();
  return join(os.tmpdir(), 'haloflux-dsh-bridge-events.jsonl');
}

/** Bounded append-only probe log: the exact normalized events, metadata only. */
class ProbeLog {
  constructor(path, logger) {
    this.path = path;
    this.logger = logger;
    this.bytes = 0;
    this.pending = Promise.resolve();
    this.reportedError = false;
    try {
      this.bytes = statSync(path).size;
    } catch {
      this.bytes = 0;
    }
  }

  write(event) {
    if (!this.path) return;
    this.append({ capturedAt: Date.now(), event });
  }

  /** Diagnostic rows are ignored by the event verifier; metadata only. */
  writeDiag(diag) {
    if (!this.path) return;
    this.append({ capturedAt: Date.now(), diag });
  }

  append(row) {
    if (!this.path) return;
    const line = `${JSON.stringify(row)}\n`;
    this.pending = this.pending
      .then(async () => {
        try {
          await fsp.mkdir(dirname(this.path), { recursive: true });
          await fsp.appendFile(this.path, line, 'utf8');
          this.bytes += Buffer.byteLength(line);
          if (this.bytes > PROBE_LOG_MAX_BYTES) {
            this.bytes = 0;
            await fsp.rename(this.path, `${this.path}.1`).catch(() => {});
          }
        } catch (error) {
          if (!this.reportedError) {
            this.reportedError = true;
            this.logger?.debug?.('haloflux-bridge: probe log unavailable', error);
          }
        }
      });
  }

  async flush() {
    try {
      await this.pending;
    } catch {
      /* ignore */
    }
  }
}

/** Small bounded HTTP poster with token auth and a token bucket. */
class BridgeClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.queue = [];
    this.inFlight = false;
    this.dropped = 0;
    this.sent = 0;
    this.lastErrorAt = 0;
    this.reportedMissingToken = false;
    this.token = '';
    this.tokenAt = 0;
    this.bucketTokens = cfg.maxEventsPerSecond;
    this.bucketAt = Date.now();
    this.endpoint = safeEndpoint(cfg.bridgeUrl);
  }

  takeToken() {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.bucketAt) / 1000;
    this.bucketAt = now;
    this.bucketTokens = Math.min(this.cfg.maxEventsPerSecond, this.bucketTokens + elapsed * this.cfg.maxEventsPerSecond);
    if (this.bucketTokens < 1) return false;
    this.bucketTokens -= 1;
    return true;
  }

  enqueue(event) {
    if (!this.takeToken()) {
      this.dropped += 1;
      return;
    }
    if (this.queue.length >= this.cfg.queueLimit) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(event);
    void this.drain();
  }

  async drain() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await this.post(event);
          if (ok) this.sent += 1;
        } catch {
          /* silent by contract */
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  readToken() {
    const now = Date.now();
    if (now - this.tokenAt < TOKEN_CACHE_MS) return this.token;
    this.tokenAt = now;
    if (this.cfg.token) {
      this.token = String(this.cfg.token);
      return this.token;
    }
    const candidates = [];
    if (this.cfg.tokenFile) candidates.push(this.cfg.tokenFile);
    candidates.push(join(halofluxHome(), 'token'));
    for (const file of candidates) {
      try {
        const text = readFileSync(file, 'utf8').trim();
        if (text) {
          this.token = text;
          return text;
        }
      } catch {
        /* try next */
      }
    }
    this.token = '';
    return '';
  }

  post(event) {
    const token = this.readToken();
    if (!token) {
      if (!this.reportedMissingToken) {
        this.reportedMissingToken = true;
        this.logger?.debug?.('haloflux-bridge: no bridge token yet; events only recorded locally');
      }
      return Promise.resolve(false);
    }
    if (!this.endpoint) return Promise.resolve(false);
    const body = Buffer.from(JSON.stringify(event), 'utf8');
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = http.request(
        {
          protocol: this.endpoint.protocol,
          hostname: this.endpoint.hostname,
          port: this.endpoint.port,
          path: '/v1/events',
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': body.length,
          },
          timeout: this.cfg.timeoutMs,
        },
        (res) => {
          res.resume();
          res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 300));
          res.on('error', () => done(false));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => {
        const now = Date.now();
        if (now - this.lastErrorAt > 30000) {
          this.lastErrorAt = now;
          this.logger?.debug?.('haloflux-bridge: bridge offline or unreachable (will retry silently)');
        }
        done(false);
      });
      try {
        req.write(body);
        req.end();
      } catch {
        done(false);
      }
    });
  }
}

function safeEndpoint(base) {
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:') return undefined;
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Live product-settings gate (metadata only; never reads anything but `enabled`). */
class ProductGate {
  constructor(logger) {
    this.logger = logger;
    this.at = 0;
    this.enabled = true;
  }

  isEnabled() {
    const now = Date.now();
    if (now - this.at < SETTINGS_CACHE_MS) return this.enabled;
    this.at = now;
    try {
      const raw = readFileSync(join(halofluxHome(), 'settings.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const entry = parsed?.hosts?.['deepseek-harness'];
      this.enabled = !(entry && entry.enabled === false);
    } catch {
      this.enabled = true;
    }
    return this.enabled;
  }
}

/** Per-session derived bookkeeping. Never stores content. */
class SessionState {
  constructor(session) {
    this.rawId = String(session?.id || 'unknown');
    this.id = normalizeSessionId(this.rawId);
    this.turn = 0;
    this.step = 0;
    this.turnStart = 0;
    this.outputKey = '';
    this.lastChunkAt = 0;
    this.turnTokens = 0;
    this.tools = new Map();
    this.approvals = new Map();
    this.model = '';
    this.contextLimit = 0;
    this.heartbeat = null;
    this.lastErrorKey = '';
    this.lastErrorAt = 0;
  }
}

/**
 * The runtime. Exported for the offline probe harness; only `apply` wires it
 * into a Cordis context.
 */
export class BridgeRuntime {
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.logger = ctx && ctx.logger;
    this.sessions = new Map();
    this.sink = new ProbeLog(resolveProbePath(cfg), this.logger);
    this.client = new BridgeClient(cfg, this.logger);
    this.gate = new ProductGate(this.logger);
    this.disposed = false;
    this.listeners = [];
    this.startedAt = Date.now();
  }

  emit(sessionState, eventType, options = {}) {
    if (this.disposed) return;
    if (!this.cfg.enabled || !this.gate.isEnabled()) return;
    try {
      const event = buildEvent({
        sessionId: sessionState.id,
        eventType,
        state: options.state,
        source: options.source || 'host-native',
        confidence: options.confidence || 'confirmed',
        timestamp: options.timestamp || Date.now(),
        seq: options.seq,
        hostVersion: this.cfg.hostVersion,
        metadata: options.metadata,
      });
      this.sink.write(event);
      this.client.enqueue(event);
    } catch {
      /* observer must never throw into the host */
    }
  }

  touch(session) {
    if (!session) return undefined;
    const rawId = String(session.id || 'unknown');
    let state = this.sessions.get(rawId);
    if (!state) {
      state = new SessionState(session);
      this.sessions.set(rawId, state);
      this.startHeartbeat(state);
    }
    return state;
  }

  startHeartbeat(state) {
    if (!this.cfg.heartbeatMs || this.disposed) return;
    try {
      const timer = setInterval(() => {
        try {
          this.emit(state, 'session.heartbeat', {
            state: 'unknown',
            source: 'derived',
            confidence: 'inferred',
            metadata: {},
          });
        } catch {
          /* ignore */
        }
      }, this.cfg.heartbeatMs);
      timer.unref?.();
      state.heartbeat = timer;
    } catch {
      /* ignore */
    }
  }

  stopHeartbeat(state) {
    if (state?.heartbeat) {
      try {
        clearInterval(state.heartbeat);
      } catch {
        /* ignore */
      }
      state.heartbeat = null;
    }
  }

  onCreated(session) {
    try {
      const state = this.touch(session);
      this.emit(state, 'session.start', { metadata: { label: 'session-created' } });
    } catch {
      /* ignore */
    }
  }

  onDisposed(session) {
    try {
      const rawId = String(session?.id || 'unknown');
      const state = this.sessions.get(rawId) || this.touch(session);
      this.emit(state, 'session.end', { metadata: { label: 'session-disposed' } });
      this.stopHeartbeat(state);
      this.sessions.delete(rawId);
    } catch {
      /* ignore */
    }
  }

  onAgentError(payload) {
    try {
      const agent = payload && payload.agent;
      const session = agent && agent.session;
      if (!session) return;
      const state = this.touch(session);
      const error = payload && payload.error;
      const code = clip(error && (error.code || error.name), 64) || 'AGENT_ERROR';
      this.emitError(state, num(payload && payload.turn), num(payload && payload.step), code);
    } catch {
      /* ignore */
    }
  }

  emitError(state, turn, step, code) {
    const key = `${turn ?? ''}:${code}`;
    const now = Date.now();
    if (state.lastErrorKey === key && now - state.lastErrorAt < 5000) return;
    state.lastErrorKey = key;
    state.lastErrorAt = now;
    this.emit(state, 'error', {
      state: 'error',
      timestamp: now,
      metadata: { turn, step, errorCode: code },
    });
  }

  onEvent(session, event) {
    try {
      if (this.disposed || !this.cfg.enabled || !this.gate.isEnabled()) return;
      if (!event || typeof event.type !== 'string') return;
      const state = this.touch(session);
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const at = typeof event.time === 'number' && event.time > 0 ? event.time : Date.now();
      switch (event.type) {
        case 'turn/start': {
          state.turn = num(data.turn) ?? state.turn;
          state.step = 0;
          state.turnStart = at;
          state.turnTokens = 0;
          state.outputKey = '';
          this.emit(state, 'run.start', {
            timestamp: at,
            seq: event.seq,
            metadata: { turn: state.turn, label: 'turn' },
          });
          break;
        }
        case 'step/start': {
          state.step = num(data.step) ?? state.step;
          state.outputKey = '';
          state.lastChunkAt = 0;
          break;
        }
        case 'user/message': {
          // Content is NEVER inspected: only source.kind, a small enum.
          const kind = data && data.source && data.source.kind;
          if (kind === 'user') {
            this.emit(state, 'task.received', {
              timestamp: at,
              seq: event.seq,
              metadata: { turn: state.turn, label: 'user-prompt' },
            });
          }
          break;
        }
        case 'request/context': {
          const provider = clip(data.provider, 40);
          const model = clip(data.model, 60);
          if (provider && model) state.model = clip(`${provider}/${model}`, 80);
          else if (model) state.model = model;
          state.contextLimit = num(data.contextWindow) ?? state.contextLimit;
          break;
        }
        case 'assistant/chunk': {
          const chunk = data.chunk;
          if (!chunk || typeof chunk !== 'object') break;
          if (chunk.type === 'text-delta') {
            const key = `${state.turn}:${state.step}`;
            if (state.outputKey !== key) {
              state.outputKey = key;
              state.lastChunkAt = at;
              this.emit(state, 'output.start', {
                timestamp: at,
                seq: event.seq,
                metadata: { turn: state.turn, step: state.step },
              });
            } else if (at - state.lastChunkAt >= this.cfg.outputChunkThrottleMs) {
              state.lastChunkAt = at;
              this.emit(state, 'output.chunk', {
                timestamp: at,
                seq: event.seq,
                metadata: { turn: state.turn, step: state.step },
              });
            }
          }
          break;
        }
        case 'assistant/message': {
          const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
          const outputTokens = num(usage.outputTokens);
          const contextUsed = sumUsageInput(usage);
          if (outputTokens !== undefined) state.turnTokens += outputTokens;
          this.emit(state, 'output.end', {
            timestamp: at,
            seq: event.seq,
            metadata: {
              turn: num(data.turn) ?? state.turn,
              step: num(data.step) ?? state.step,
              tokenCount: outputTokens,
              contextUsed,
              contextLimit: state.contextLimit || undefined,
              model: state.model || undefined,
            },
          });
          break;
        }
        case 'tool/call': {
          const callId = typeof data.callId === 'string' ? data.callId : '';
          const toolName = this.cfg.includeToolNames ? clip(data.name, 80) : 'tool';
          if (callId) state.tools.set(callId, { name: toolName, at });
          this.emit(state, 'tool.start', {
            timestamp: at,
            seq: event.seq,
            metadata: {
              toolName,
              toolCategory: this.cfg.includeToolNames ? toolCategory(toolName) : undefined,
              toolStatus: 'running',
              turn: num(data.turn) ?? state.turn,
              step: num(data.step) ?? state.step,
            },
          });
          break;
        }
        case 'tool/result': {
          const callId = data && data.message && data.message.source && data.message.source.callId;
          const call = typeof callId === 'string' ? state.tools.get(callId) : undefined;
          if (typeof callId === 'string') state.tools.delete(callId);
          const failed = Boolean(
            (data.message && data.message.isError === true) || (data.error && typeof data.error === 'object'),
          );
          const errorCode = failed ? clip(data.error && data.error.code, 64) || 'TOOL_ERROR' : undefined;
          this.emit(state, failed ? 'tool.fail' : 'tool.end', {
            timestamp: at,
            seq: event.seq,
            metadata: {
              toolName: call?.name || (this.cfg.includeToolNames ? 'tool' : 'tool'),
              toolCategory: call?.name ? toolCategory(call.name) : undefined,
              toolStatus: failed ? 'failed' : 'ok',
              turn: num(data.turn) ?? state.turn,
              step: num(data.step) ?? state.step,
              durationMs: call ? Math.max(0, at - call.at) : undefined,
              errorCode,
            },
          });
          break;
        }
        case 'approval/asked': {
          const toolName = this.cfg.includeToolNames ? clip(data.toolName, 80) : 'tool';
          if (typeof data.id === 'string') state.approvals.set(data.id, { name: toolName, at });
          this.emit(state, 'approval.request', {
            timestamp: at,
            seq: event.seq,
            metadata: {
              toolName,
              toolCategory: toolName ? toolCategory(toolName) : undefined,
              approvalKind: 'tool',
              label: 'approval',
            },
          });
          break;
        }
        case 'approval/decided': {
          const pending = typeof data.id === 'string' ? state.approvals.get(data.id) : undefined;
          if (typeof data.id === 'string') state.approvals.delete(data.id);
          const outcome = data.outcome;
          const toolStatus = outcome === 'allowed-once' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'failed';
          this.emit(state, 'approval.resolve', {
            timestamp: at,
            seq: event.seq,
            metadata: {
              toolName: pending?.name,
              toolStatus,
              approvalKind: 'tool',
              durationMs: pending ? Math.max(0, at - pending.at) : undefined,
              label: clip(outcome, 40),
            },
          });
          break;
        }
        case 'turn/end': {
          const turn = num(data.turn) ?? state.turn;
          const reason = data.reason && typeof data.reason === 'object' ? data.reason : {};
          const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown';
          const durationMs = state.turnStart > 0 ? Math.max(0, at - state.turnStart) : undefined;
          if (kind === 'error') {
            const code = clip(reason.error && reason.error.code, 64) || 'TURN_ERROR';
            this.emitError(state, turn, undefined, code);
          } else {
            this.emit(state, 'run.end', {
              timestamp: at,
              seq: event.seq,
              metadata: {
                turn,
                durationMs,
                tokenCount: state.turnTokens || undefined,
                model: state.model || undefined,
                label: kind,
              },
            });
          }
          state.outputKey = '';
          state.turnStart = 0;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      try {
        this.logger?.debug?.('haloflux-bridge: session event dropped', error);
      } catch {
        /* ignore */
      }
    }
  }

  adoptExisting() {
    try {
      // The plugin's own ctx does not necessarily expose service properties.
      // `ctx.inject(['sessions'], …)` is the public way to obtain them; the
      // direct/`get` paths are fallbacks for Host builds that expose either.
      const direct = this.ctx && this.ctx.sessions;
      const viaGet = !direct && this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('sessions') : undefined;
      const sessions = this.sessionsService || direct || viaGet;
      const list = sessions && typeof sessions.list === 'function' ? sessions.list() : [];
      try {
        this.sink.writeDiag({
          phase: 'adopt',
          via: this.sessionsService ? 'inject' : direct ? 'property' : viaGet ? 'get' : 'none',
          count: list.length,
        });
      } catch {
        /* ignore */
      }
      for (const session of list) {
        try {
          const state = this.touch(session);
          this.emit(state, 'session.start', { metadata: { label: 'adopted-live' } });
        } catch {
          /* ignore one session */
        }
      }
    } catch {
      /* ignore */
    }
  }

  start() {
    try {
      this.sink.writeDiag({
        phase: 'start',
        hasCtx: Boolean(this.ctx),
        hasInject: typeof this.ctx?.inject,
        hasGet: typeof this.ctx?.get,
        hasSessions: Boolean(this.ctx?.sessions),
      });
    } catch {
      /* ignore */
    }
    const on = (event, handler) => {
      try {
        if (this.ctx && typeof this.ctx.on === 'function') {
          this.ctx.on(event, handler);
          this.listeners.push(event);
        }
      } catch (error) {
        this.logger?.debug?.(`haloflux-bridge: cannot subscribe ${event}`, error);
      }
    };
    on('session/created', (session) => this.onCreated(session));
    on('session/event', (session, event) => this.onEvent(session, event));
    on('session/disposed', (session) => this.onDisposed(session));
    on('agent/error', (payload) => this.onAgentError(payload));
    // Existing sessions were announced before this plugin mounted. Ask the
    // injection system for the session store rather than assuming its property
    // exists on this plugin's own context.
    const adopt = () => this.adoptExisting();
    try {
      if (this.ctx && typeof this.ctx.inject === 'function') {
        this.ctx.inject(['sessions'], (sctx) => {
          try {
            this.sessionsService = sctx.sessions;
          } catch {
            /* keep fallbacks */
          }
          adopt();
        });
      } else {
        const timer = setTimeout(adopt, 250);
        timer.unref?.();
      }
    } catch {
      try {
        const timer = setTimeout(adopt, 250);
        timer.unref?.();
      } catch {
        adopt();
      }
    }
    this.logger?.debug?.(`haloflux-bridge: started (${this.listeners.length} listeners, bridge ${this.cfg.bridgeUrl})`);
  }

  async dispose() {
    this.disposed = true;
    for (const state of this.sessions.values()) this.stopHeartbeat(state);
    this.sessions.clear();
    try {
      await this.sink.flush();
    } catch {
      /* ignore */
    }
  }
}

function sumUsageInput(usage) {
  const parts = [num(usage.inputTokens), num(usage.cacheReadTokens), num(usage.cacheWriteTokens)];
  const defined = parts.filter((value) => value !== undefined);
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, value) => sum + value, 0);
}

/** Cordis plugin entry. */
export function apply(ctx, entryConfig) {
  try {
    const cfg = resolveConfig(entryConfig);
    if (!cfg.enabled) {
      try {
        ctx?.logger?.debug?.('haloflux-bridge: disabled by config');
      } catch {
        /* ignore */
      }
      return;
    }
    const runtime = new BridgeRuntime(ctx, cfg);
    runtime.start();
    try {
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          void runtime.dispose();
        });
      }
    } catch {
      /* cleanup is best effort */
    }
  } catch (error) {
    // A broken observer must never fail the Host composition.
    try {
      ctx?.logger?.warn?.('haloflux-bridge: failed to start', error);
    } catch {
      /* ignore */
    }
  }
}

export default apply;
