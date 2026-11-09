/**
 * HALOFLUX session manager — multi-session state machine (contract §5 + §7).
 *
 * Responsibilities:
 *  - eventId dedupe with a 4096-entry ring buffer (per bridge);
 *  - out-of-order policy: events older than `lastApplied.timestamp - 5000` are
 *    applied to metrics only and never regress `state`;
 *  - timeout ladder, checked by a 1 s ticker (injectable clock for tests):
 *      tool stale > 10 min          -> unknown + warning
 *      running|output stale > 150 s -> unknown + warning
 *      waiting_approval stale > 15m -> unknown + warning
 *      idle|done quiet >= 45 s      -> connected (host alive, idle)
 *      connected unseen > 10 min    -> disconnected
 *  - SessionView snapshots and the `hosts[]` capability list;
 *  - subscription callbacks used by the bridge's SSE stream.
 *
 * The manager never invents numbers: token/context metrics stay absent unless a
 * host event supplied them. All imports are Node built-ins plus the frozen
 * event schema constants.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION } from '../../event-schema/dist/index.js';

export const SESSION_MANAGER_VERSION = '0.1.0';

/**
 * Session provenance never degrades: a derived heartbeat must not turn a
 * host-native/confirmed session into "inferred". Rank by confidence; equal
 * ranks keep the newest event's source.
 */
const CONFIDENCE_RANK = Object.freeze({ confirmed: 3, inferred: 2, unverified: 1 });
const confidenceRank = (value) => CONFIDENCE_RANK[value] || 0;

/** Capability keys exposed to the renderer (contract §5 example). */
export const CAPABILITY_KEYS = Object.freeze([
  'sessionStart',
  'toolUse',
  'tokenMetrics',
  'approval',
  'outputStream',
]);

export const DEFAULT_CAPABILITIES = Object.freeze(
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])),
);

export const DEFAULT_TIMEOUTS = Object.freeze({
  outOfOrderWindowMs: 5000,
  toolTimeoutMs: 10 * 60 * 1000,
  runningTimeoutMs: 150 * 1000,
  approvalTimeoutMs: 15 * 60 * 1000,
  idleToConnectedMs: 45 * 1000,
  connectedToDisconnectedMs: 10 * 60 * 1000,
  recentEventsLimit: 200,
  dedupeRingSize: 4096,
  maxSessions: 200,
  tickIntervalMs: 1000,
});

/** Metadata keys copied into SessionView.metrics (never invented). */
export const METRIC_METADATA_KEYS = Object.freeze([
  'toolName',
  'step',
  'turn',
  'tokenCount',
  'tokensPerSecond',
  'contextUsed',
  'contextLimit',
  'model',
  'projectName',
  'sessionTitle',
]);

const TIMEOUT_WARNING_CODES = Object.freeze([
  'stale-tool-timeout',
  'stale-running-timeout',
  'stale-approval-timeout',
  'auto-connected',
  'auto-disconnected',
]);

const DEFAULT_ADAPTERS_DIR = path.resolve(fileURLToPath(new URL('../../../adapters/', import.meta.url)));

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Fixed-size ring buffer of eventIds (O(1) membership, O(1) eviction). */
export class EventIdRing {
  constructor(limit = 4096) {
    this.limit = Math.max(1, limit | 0);
    this.set = new Set();
    this.order = new Array(this.limit);
    this.index = 0;
    this.size = 0;
  }

  has(eventId) {
    return this.set.has(eventId);
  }

  add(eventId) {
    if (this.set.has(eventId)) return false;
    if (this.size === this.limit) {
      this.set.delete(this.order[this.index]);
    } else {
      this.size += 1;
    }
    this.order[this.index] = eventId;
    this.set.add(eventId);
    this.index = (this.index + 1) % this.limit;
    return true;
  }

  clear() {
    this.set.clear();
    this.order = new Array(this.limit);
    this.index = 0;
    this.size = 0;
  }
}

function pickTimeoutOptions(options = {}) {
  const config = { ...DEFAULT_TIMEOUTS, ...(isPlainObject(options.config) ? options.config : {}) };
  for (const key of Object.keys(DEFAULT_TIMEOUTS)) {
    if (options[key] !== undefined) config[key] = options[key];
  }
  return config;
}

function pushWarning(session, code) {
  session.warnings.add(code);
}

function clearTimeoutWarnings(session) {
  for (const code of TIMEOUT_WARNING_CODES) session.warnings.delete(code);
}

function nowOrThrow(clock, value) {
  const now = value === undefined ? clock() : value;
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('clock() must return a finite epoch-ms number');
  }
  return now;
}

/**
 * @typedef {object} SessionManagerOptions
 * @property {() => number} [clock] injectable clock (tests)
 * @property {object} [config] timeout overrides (see DEFAULT_TIMEOUTS)
 * @property {string} [capabilitiesDir] adapters directory (default <repo>/adapters)
 * @property {(host: string) => object | null} [capabilityProvider] test seam
 * @property {string} [version] reported bridge version
 * @property {number} [tickIntervalMs]
 */

export class SessionManager {
  constructor(options = {}) {
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.config = pickTimeoutOptions(options);
    this.version = options.version || SESSION_MANAGER_VERSION;
    this.capabilitiesDir = options.capabilitiesDir === undefined ? DEFAULT_ADAPTERS_DIR : options.capabilitiesDir;
    this.capabilityProvider = typeof options.capabilityProvider === 'function' ? options.capabilityProvider : null;
    this.createdAt = nowOrThrow(this.clock);

    this.sessions = new Map();
    this.hostInfo = new Map();
    this.listeners = new Set();
    this.seenEventIds = new EventIdRing(this.config.dedupeRingSize);

    this.eventCount = 0;
    this.duplicates = 0;
    this.dropped = 0;
    this.outOfOrder = 0;
    this.activeSessionId = null;
    this.lastIngestAt = null;

    this._timer = null;
    this._lastChangeReason = null;
  }

  /** Number of tracked sessions (snapshot count, includes disconnected ones). */
  get sessionCount() {
    return this.sessions.size;
  }

  /** Subscribe to any state change; returns an unsubscribe function. */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange(reason = 'update') {
    this._lastChangeReason = reason;
    for (const listener of [...this.listeners]) {
      try {
        listener(reason);
      } catch {
        /* a broken subscriber must never break the state machine */
      }
    }
  }

  /**
   * Apply one validated event.
   * @returns {{status: 'applied'|'metrics-only'|'duplicate', duplicate: boolean, sessionId: string}}
   */
  ingest(event) {
    if (!event || typeof event !== 'object' || typeof event.eventId !== 'string') {
      throw new TypeError('ingest(event) requires a validated event object');
    }
    if (typeof event.sessionId !== 'string' || event.sessionId.length === 0) {
      throw new TypeError('ingest(event) requires event.sessionId');
    }

    const now = nowOrThrow(this.clock);

    if (this.seenEventIds.has(event.eventId)) {
      this.duplicates += 1;
      this.emitChange('duplicate');
      return { status: 'duplicate', duplicate: true, sessionId: event.sessionId };
    }
    this.seenEventIds.add(event.eventId);
    this.eventCount += 1;
    this.lastIngestAt = now;

    let session = this.sessions.get(event.sessionId);
    if (!session) {
      session = this.#createSession(event, now);
      this.sessions.set(event.sessionId, session);
      this.#enforceSessionLimit(now);
    }

    session.host = event.host;
    if (event.hostVersion) session.hostVersion = event.hostVersion;
    session.lastArrival = now;
    session.eventCount += 1;
    this.activeSessionId = event.sessionId;

    this.#touchHost(event.host, event.hostVersion, event.timestamp, now);
    this.#correlateTool(session, event);
    this.#pushRecent(session, event);
    this.#mergeMetrics(session, event.metadata);

    const lastApplied = session.lastAppliedTimestamp;
    const outOfOrder =
      typeof lastApplied === 'number' && event.timestamp < lastApplied - this.config.outOfOrderWindowMs;

    if (outOfOrder) {
      this.outOfOrder += 1;
      session.outOfOrderCount += 1;
      session.lastEventAt = Math.max(session.lastEventAt, event.timestamp);
      pushWarning(session, 'out-of-order-event');
      this.emitChange('metrics-only');
      return { status: 'metrics-only', duplicate: false, sessionId: event.sessionId };
    }

    const previousState = session.state;
    clearTimeoutWarnings(session);
    session.state = event.state;
    session.reportedState = event.state;
    if (confidenceRank(event.confidence) >= confidenceRank(session.confidence)) {
      session.source = event.source;
      session.confidence = event.confidence;
    }
    session.connected = event.state !== 'disconnected';
    session.startedAt = Math.min(session.startedAt, event.timestamp);
    session.lastEventAt = Math.max(session.lastEventAt, event.timestamp);
    session.lastAppliedTimestamp = Math.max(
      typeof lastApplied === 'number' ? lastApplied : Number.NEGATIVE_INFINITY,
      event.timestamp,
    );
    session.lastEventId = event.eventId;
    if (previousState !== event.state) session.stateChangedAt = now;

    this.emitChange('event');
    return { status: 'applied', duplicate: false, sessionId: event.sessionId };
  }

  /** Run the timeout ladder once. Returns true when any session changed. */
  tick(now = this.clock()) {
    return this.evaluateTimeouts(now);
  }

  /** Run the timeout ladder once (alias used by tests). */
  evaluateTimeouts(now = this.clock(), { notify = true } = {}) {
    const at = nowOrThrow(this.clock, now);
    let changed = false;

    for (const session of this.sessions.values()) {
      const idleFor = at - session.lastEventAt;
      if (!Number.isFinite(idleFor) || idleFor < 0) continue;

      // Cascade rules inside one tick so a long gap settles deterministically:
      // e.g. idle (15 min) -> connected -> disconnected.
      for (let step = 0; step < 4; step += 1) {
        const transition = this.#nextTimeoutTransition(session, idleFor);
        if (!transition) break;
        session.state = transition.state;
        session.source = 'derived';
        session.confidence = 'inferred';
        session.connected = transition.state !== 'disconnected';
        session.stateChangedAt = at;
        pushWarning(session, transition.warning);
        changed = true;
      }
    }

    if (changed && notify) this.emitChange('timeout');
    return changed;
  }

  #nextTimeoutTransition(session, idleFor) {
    const { config } = this;
    if (session.state === 'tool' && idleFor > config.toolTimeoutMs) {
      return { state: 'unknown', warning: 'stale-tool-timeout' };
    }
    if ((session.state === 'running' || session.state === 'output') && idleFor > config.runningTimeoutMs) {
      return { state: 'unknown', warning: 'stale-running-timeout' };
    }
    if (session.state === 'waiting_approval' && idleFor > config.approvalTimeoutMs) {
      return { state: 'unknown', warning: 'stale-approval-timeout' };
    }
    if ((session.state === 'idle' || session.state === 'done') && idleFor >= config.idleToConnectedMs) {
      return { state: 'connected', warning: 'auto-connected' };
    }
    // Contract §7: only `connected` sessions unseen > 10 min become disconnected.
    if (session.state === 'connected' && idleFor > config.connectedToDisconnectedMs) {
      return { state: 'disconnected', warning: 'auto-disconnected' };
    }
    return null;
  }

  /** Start the 1 s timeout ticker (unref'ed so it never keeps a test process alive). */
  start(intervalMs = this.config.tickIntervalMs) {
    if (this._timer) return;
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : this.config.tickIntervalMs;
    this._timer = setInterval(() => {
      try {
        this.evaluateTimeouts(this.clock());
      } catch {
        /* a clock failure must not crash the bridge */
      }
    }, interval);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Full replacement snapshot (contract §5 shape). */
  snapshot(now = this.clock()) {
    const at = nowOrThrow(this.clock, now);
    this.evaluateTimeouts(at);

    const sessions = [...this.sessions.values()].map((session) => this.#sessionView(session));
    const hosts = this.#hostViews(sessions);

    return {
      schemaVersion: SCHEMA_VERSION,
      serverTime: at,
      activeSessionId: this.activeSessionId,
      hosts,
      sessions,
      bridge: {
        version: this.version,
        uptimeMs: Math.max(0, at - this.createdAt),
        eventCount: this.eventCount,
        dropped: this.dropped,
        duplicates: this.duplicates,
      },
    };
  }

  /** Convenience: only the hosts[] array (used by tests / diagnostics). */
  hostViews(now = this.clock()) {
    return this.#hostViews([...this.sessions.values()].map((session) => this.#sessionView(session)));
  }

  #createSession(event, now) {
    this.#touchHost(event.host, event.hostVersion, event.timestamp, now);
    const session = {
      sessionId: event.sessionId,
      host: event.host,
      hostVersion: event.hostVersion || '',
      state: event.state,
      reportedState: event.state,
      source: event.source,
      confidence: event.confidence,
      connected: event.state !== 'disconnected',
      startedAt: event.timestamp,
      lastEventAt: event.timestamp,
      lastAppliedTimestamp: undefined,
      lastEventId: undefined,
      stateChangedAt: now,
      lastArrival: now,
      metrics: {},
      recentEvents: [],
      // toolCallId -> { at, name } for duration correlation; never persisted.
      openTools: new Map(),
      warnings: new Set(),
      eventCount: 0,
      duplicateCount: 0,
      outOfOrderCount: 0,
    };
    const host = this.hostInfo.get(event.host);
    if (host && host.capabilitiesSource === 'default') pushWarning(session, `capabilities-default:${event.host}`);
    return session;
  }

  #touchHost(host, hostVersion, eventTimestamp, now) {
    let info = this.hostInfo.get(host);
    if (!info) {
      const loaded = this.#loadCapabilities(host);
      info = {
        host,
        hostVersion: hostVersion || '',
        lastSeen: eventTimestamp,
        capabilities: loaded.capabilities,
        capabilitiesSource: loaded.source,
        warnings: loaded.warnings,
      };
      this.hostInfo.set(host, info);
      return;
    }
    if (hostVersion) info.hostVersion = hostVersion;
    info.lastSeen = Math.max(info.lastSeen, eventTimestamp);
  }

  #loadCapabilities(host) {
    if (this.capabilityProvider) {
      try {
        const provided = this.capabilityProvider(host);
        if (provided && this.#mergeCapabilities(provided)) {
          return { capabilities: this.#mergeCapabilities(provided), source: 'adapter', warnings: [] };
        }
      } catch {
        /* fall through to file/default */
      }
    }
    if (this.capabilitiesDir) {
      try {
        const file = path.join(this.capabilitiesDir, host, 'capabilities.json');
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const declared = isPlainObject(parsed) && isPlainObject(parsed.capabilities) ? parsed.capabilities : parsed;
        const capabilities = this.#mergeCapabilities(declared);
        if (capabilities) return { capabilities, source: 'adapter', warnings: [] };
        return {
          capabilities: { ...DEFAULT_CAPABILITIES },
          source: 'default',
          warnings: [`capabilities-file-empty:${host}`],
        };
      } catch (error) {
        if (error && error.code !== 'ENOENT') {
          return {
            capabilities: { ...DEFAULT_CAPABILITIES },
            source: 'default',
            warnings: [`capabilities-read-failed:${host}:${error.code || 'unknown'}`],
          };
        }
      }
    }
    return {
      capabilities: { ...DEFAULT_CAPABILITIES },
      source: 'default',
      warnings: [`capabilities-default:${host}`, 'defaults-are-all-false'],
    };
  }

  #mergeCapabilities(declared) {
    if (!isPlainObject(declared)) return null;
    const capabilities = { ...DEFAULT_CAPABILITIES };
    let found = false;
    for (const key of CAPABILITY_KEYS) {
      if (typeof declared[key] === 'boolean') {
        capabilities[key] = declared[key];
        found = true;
      }
    }
    return found ? capabilities : null;
  }

  #enforceSessionLimit(now) {
    if (this.sessions.size <= this.config.maxSessions) return;
    let oldest = null;
    for (const session of this.sessions.values()) {
      if (session.connected) continue;
      if (session.sessionId === this.activeSessionId) continue;
      if (!oldest || session.lastArrival < oldest.lastArrival) oldest = session;
    }
    if (oldest) this.sessions.delete(oldest.sessionId);
  }

  #pushRecent(session, event) {
    const entry = { eventType: event.eventType, timestamp: event.timestamp };
    // Event-level provenance, not the session aggregate: a derived heartbeat in
    // a host-native session must still render as DRV/inferred.
    entry.source = event.source;
    entry.confidence = event.confidence;
    if (event.metadata && typeof event.metadata.label === 'string') entry.label = event.metadata.label;
    if (event.metadata && typeof event.metadata.toolName === 'string') entry.toolName = event.metadata.toolName;
    if (event.metadata && typeof event.metadata.toolCallId === 'string') entry.toolCallId = event.metadata.toolCallId;
    if (event.metadata && typeof event.metadata.runId === 'string') entry.runId = event.metadata.runId;
    if (event.metadata && typeof event.metadata.durationMs === 'number') entry.durationMs = event.metadata.durationMs;
    if (event.metadata && typeof event.metadata.errorCode === 'string') entry.errorCode = event.metadata.errorCode;
    session.recentEvents.push(entry);
    if (session.recentEvents.length > this.config.recentEventsLimit) {
      session.recentEvents.splice(0, session.recentEvents.length - this.config.recentEventsLimit);
      this.dropped += 1;
    }
  }

  /**
   * Correlate tool.start -> tool.end/fail by the host-issued toolCallId.
   * Duration is only filled when the host supplied ids and timestamps; an
   * unmatched end stays uncorrelated and no duration is invented.
   */
  #correlateTool(session, event) {
    const meta = event.metadata;
    if (!isPlainObject(meta)) return;
    const callId = typeof meta.toolCallId === 'string' ? meta.toolCallId : '';
    if (!callId) return;
    const runId = typeof meta.runId === 'string' ? meta.runId : '';
    // A reused call id across runs must not match: the key carries run context
    // whenever the host supplies it. A missing runId stays in its own bucket.
    const key = `${runId}\u0000${callId}`;
    session.metrics.lastToolCallId = callId;
    if (event.eventType === 'tool.start') {
      // A duplicate start for the same key must not reset the original clock.
      if (!session.openTools.has(key)) {
        session.openTools.set(key, { at: event.timestamp, name: meta.toolName, runId });
      }
      session.metrics.lastToolCorrelated = false;
      return;
    }
    if (event.eventType !== 'tool.end' && event.eventType !== 'tool.fail') return;
    const open = session.openTools.get(key);
    if (open) session.openTools.delete(key);
    // An end older than its start is out-of-order in this cache; never invent a
    // negative/zero duration from it.
    if (open && event.timestamp < open.at) {
      session.metrics.lastToolCorrelated = false;
      return;
    }
    session.metrics.lastToolCorrelated = Boolean(open);
    if (open && typeof meta.durationMs !== 'number') {
      event.metadata = { ...meta, durationMs: Math.max(0, event.timestamp - open.at) };
    }
    if (open && typeof event.metadata?.durationMs === 'number') {
      session.metrics.lastToolDurationMs = event.metadata.durationMs;
    }
  }

  #mergeMetrics(session, metadata) {
    if (!isPlainObject(metadata)) return;
    for (const key of METRIC_METADATA_KEYS) {
      const value = metadata[key];
      if (value !== undefined) session.metrics[key] = value;
    }
  }

  #sessionView(session) {
    const metrics = {};
    for (const key of METRIC_METADATA_KEYS) {
      if (session.metrics[key] !== undefined) metrics[key] = session.metrics[key];
    }
    for (const key of ['lastToolCallId', 'lastToolDurationMs', 'lastToolCorrelated']) {
      if (session.metrics[key] !== undefined) metrics[key] = session.metrics[key];
    }
    return {
      sessionId: session.sessionId,
      host: session.host,
      hostVersion: session.hostVersion,
      state: session.state,
      reportedState: session.reportedState,
      source: session.source,
      confidence: session.confidence,
      connected: session.connected,
      lastEventAt: session.lastEventAt,
      startedAt: session.startedAt,
      metrics,
      recentEvents: session.recentEvents.map((entry) => ({ ...entry })),
      warnings: [...session.warnings],
    };
  }

  #hostViews(sessions) {
    const hosts = [];
    for (const info of this.hostInfo.values()) {
      const hostSessions = sessions.filter((session) => session.host === info.host);
      const lastSeen = hostSessions.reduce((max, session) => Math.max(max, session.lastEventAt), info.lastSeen);
      hosts.push({
        host: info.host,
        hostVersion: info.hostVersion,
        connected: hostSessions.some((session) => session.connected),
        lastSeen,
        capabilities: { ...info.capabilities },
        capabilitiesSource: info.capabilitiesSource,
        warnings: [...info.warnings],
      });
    }
    hosts.sort((a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host));
    return hosts;
  }
}

export default SessionManager;
