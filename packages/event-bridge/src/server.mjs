/**
 * HALOFLUX loopback event bridge (contract §3, §4, §5, §6, §10).
 *
 * HTTP + SSE server on 127.0.0.1 only. Node built-ins only. The token is never
 * written to logs or error bodies; all comparisons are constant-time.
 *
 * Run: node packages/event-bridge/src/server.mjs
 * Env: HALOFLUX_BRIDGE_PORT (default 17817, 0 = OS-assigned),
 *      HALOFLUX_HOME, HALOFLUX_TOKEN, HALOFLUX_TOKEN_FILE,
 *      HALOFLUX_LOG_LEVEL (debug|info|warn|error|silent).
 */

import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseBatch, SCHEMA_VERSION } from '../../event-schema/dist/index.js';
import { SessionManager } from '../../session-manager/src/index.mjs';
import { EventStore } from '../../event-store/src/index.mjs';
import {
  MAX_SETTINGS_BYTES,
  loadSettings,
  updateSettings,
} from '../../settings/src/index.mjs';
import {
  ensureToken,
  halofluxHome,
  redactSecrets,
  timingSafeEqual,
  tokenPath,
} from './token.mjs';
import { SCENARIO_NAMES, buildStepEvent, scenarioSteps } from './simulator.mjs';

export const BRIDGE_NAME = 'haloflux-bridge';
export const BRIDGE_VERSION = '0.1.0';
export const BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_PORT = 17817;
export const DEFAULT_RATE_LIMIT_PER_SECOND = 240;
export const MAX_EVENT_BODY_BYTES = 256 * 1024;
export const MAX_SIMULATE_BODY_BYTES = 16 * 1024;
export const UPDATE_THROTTLE_MS = 250;
export const PING_INTERVAL_MS = 15 * 1000;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOST_HEADER_RE = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i;
const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Parse HALOFLUX_BRIDGE_PORT (0 = OS-assigned), tolerating bad values. */
export function resolvePort(env = process.env) {
  const raw = env.HALOFLUX_BRIDGE_PORT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) return DEFAULT_PORT;
  return value;
}

/** Minimal leveled logger that can never print the bridge token. */
export function createLogger(level = 'info', secrets = []) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const threshold = levels[String(level).toLowerCase()] ?? levels.info;
  const secretList = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (secret) => typeof secret === 'string' && secret.length >= 8,
  );
  const emit = (name, args) => {
    if ((levels[name] ?? 20) < threshold) return;
    const text = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    const safe = redactSecrets(text, secretList);
    if (name === 'warn') console.warn(safe);
    else if (name === 'error') console.error(safe);
    else console.log(safe);
  };
  return {
    level: String(level).toLowerCase(),
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return LOOPBACK_ADDRESSES.has(address) || address.startsWith('127.');
}

function validHostHeader(host) {
  return typeof host === 'string' && HOST_HEADER_RE.test(host);
}

/** @returns {{ok: true, allow: string|null}|{ok: false}} */
export function validateOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return { ok: true, allow: null };
  const value = String(origin);
  if (value === 'null') return { ok: true, allow: 'null' };
  if (value.startsWith('file://')) return { ok: true, allow: value };
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOOPBACK_ORIGIN_HOSTS.has(parsed.hostname)) {
      return { ok: true, allow: value };
    }
  } catch {
    /* fall through */
  }
  return { ok: false };
}

function headerToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const header = req.headers['x-haloflux-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

function queryToken(url) {
  const value = url.searchParams.get('token');
  return value && value.trim() ? value.trim() : null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    const onData = (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        finished = true;
        req.removeListener('data', onData);
        req.resume();
        const error = new Error('payload too large');
        error.statusCode = 413;
        error.limit = limit;
        reject(error);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

/**
 * Create the bridge (does not listen yet; call start()).
 * @param {object} [options]
 * @returns {object}
 */
export function createBridgeServer(options = {}) {
  const env = options.env || process.env;
  const home = options.home ? path.resolve(String(options.home)) : halofluxHome(env);
  const tokenFile = options.tokenFile
    ? path.resolve(String(options.tokenFile))
    : env.HALOFLUX_TOKEN_FILE
      ? path.resolve(String(env.HALOFLUX_TOKEN_FILE))
      : path.join(home, 'token');
  const tokenInfo = options.token
    ? { token: String(options.token), source: 'option', path: tokenFile, created: false }
    : ensureToken({ env, file: tokenFile });
  if (!tokenInfo.token) throw new Error('unable to initialize bridge token');
  const bridgeToken = tokenInfo.token;

  const logger =
    options.logger || createLogger(options.logLevel || env.HALOFLUX_LOG_LEVEL || 'info', bridgeToken);
  const settingsFile = options.settingsPath
    ? path.resolve(String(options.settingsPath))
    : path.join(home, 'settings.json');
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  let eventStore = options.eventStore || null;
  let eventStoreError = '';
  if (!eventStore && String(env.HALOFLUX_EVENT_STORE || '1') !== '0') {
    try {
      eventStore = new EventStore({ home });
      const retentionDays = Math.max(1, Number(env.HALOFLUX_EVENT_RETENTION_DAYS) || 30);
      eventStore.pruneBefore(Date.now() - retentionDays * 86400000);
    } catch (error) {
      eventStoreError = error && error.message ? error.message : String(error);
      logger.warn(`event store disabled: ${redactSecrets(eventStoreError)}`);
    }
  }
  const manager =
    options.manager ||
    new SessionManager({
      clock,
      capabilitiesDir: options.capabilitiesDir,
      config: options.sessionConfig,
      version: BRIDGE_VERSION,
    });

  const eventBodyLimit = options.eventBodyLimit || MAX_EVENT_BODY_BYTES;
  const settingsBodyLimit = options.settingsBodyLimit || MAX_SETTINGS_BYTES;
  const simulateBodyLimit = options.simulateBodyLimit || MAX_SIMULATE_BODY_BYTES;
  const rateLimitPerSecond =
    options.rateLimitPerSecond === undefined ? DEFAULT_RATE_LIMIT_PER_SECOND : options.rateLimitPerSecond;
  const rateLimitWindowMs = options.rateLimitWindowMs || 1000;
  const updateThrottleMs = options.updateThrottleMs === undefined ? UPDATE_THROTTLE_MS : options.updateThrottleMs;
  const pingIntervalMs = options.pingIntervalMs === undefined ? PING_INTERVAL_MS : options.pingIntervalMs;
  const enableSimulate =
    options.enableSimulate === undefined ? env.HALOFLUX_DISABLE_SIMULATE !== '1' : options.enableSimulate !== false;

  const startedAt = clock();
  const clients = new Set();
  const simTimers = new Set();
  const rateBuckets = new WeakMap();
  let pingTimer = null;
  let listeningPort = null;
  let stopping = false;

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  function applyCors(res, origin) {
    if (!origin) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Haloflux-Token');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    if (res.writableEnded || res.headersSent) return;
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
    res.end(body);
  }

  function sendIssues(res, issues) {
    sendJson(res, 400, { issues });
  }

  function sendUnauthorized(res) {
    sendJson(res, 401, { error: 'unauthorized' });
  }

  function sendPayloadTooLarge(res, limit) {
    sendJson(res, 413, { error: 'payload_too_large', limitBytes: limit }, { Connection: 'close' });
  }

  function sendRateLimited(res, retryAfterMs) {
    sendJson(
      res,
      429,
      { error: 'rate_limited', retryAfterMs },
      { 'Retry-After': '1' },
    );
  }

  function sendMethodNotAllowed(res, allow) {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allow });
  }

  function authorized(presented) {
    return timingSafeEqual(presented, bridgeToken);
  }

  function checkRate(socket) {
    if (!rateLimitPerSecond || rateLimitPerSecond <= 0) return true;
    const now = clock();
    let bucket = rateBuckets.get(socket);
    if (!bucket || now - bucket.windowStart >= rateLimitWindowMs) {
      bucket = { windowStart: now, count: 0 };
      rateBuckets.set(socket, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= rateLimitPerSecond) return true;
    bucket.retryAfterMs = Math.max(0, rateLimitWindowMs - (now - bucket.windowStart));
    return false;
  }

  async function parseJsonRequest(req, res, limit) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      sendPayloadTooLarge(res, limit);
      req.resume();
      return { ok: false, tooLarge: true };
    }
    let text;
    try {
      text = await readBody(req, limit);
    } catch (error) {
      if (error && error.statusCode === 413) {
        sendPayloadTooLarge(res, limit);
        return { ok: false, tooLarge: true };
      }
      throw error;
    }
    if (!text.trim()) {
      sendIssues(res, [{ path: '$', code: 'invalid_json', message: 'request body is empty' }]);
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      sendIssues(res, [{ path: '$', code: 'invalid_json', message: 'request body is not valid JSON' }]);
      return { ok: false };
    }
  }

  async function handleEvents(req, res) {
    const parsed = await parseJsonRequest(req, res, eventBodyLimit);
    if (!parsed.ok) return;
    let events;
    try {
      events = parseBatch(parsed.value);
    } catch (error) {
      const issues = Array.isArray(error && error.issues)
        ? error.issues
        : [{ path: '$', code: 'invalid_batch', message: error && error.message ? error.message : 'invalid batch' }];
      sendIssues(res, issues);
      return;
    }

    let accepted = 0;
    let duplicates = 0;
    const affected = new Set();
    const persisted = [];
    for (const event of events) {
      const result = manager.ingest(event);
      if (result.duplicate) duplicates += 1;
      else {
        accepted += 1;
        persisted.push(event);
        affected.add(event.sessionId);
      }
    }
    let stored = { inserted: 0, duplicates: 0 };
    let persistedOk = true;
    if (eventStore && persisted.length > 0) {
      try {
        stored = eventStore.appendMany(persisted);
      } catch (error) {
        persistedOk = false;
        logger.warn(`event store append failed: ${redactSecrets(error && error.message ? error.message : String(error))}`);
      }
    }
    sendJson(res, 202, {
      accepted,
      duplicates,
      sessions: affected.size,
      totalSessions: manager.sessionCount,
      events: events.length,
      stored: stored.inserted,
      storeDuplicates: stored.duplicates,
      persisted: persistedOk && Boolean(eventStore),
    });
  }

  function handleState(res) {
    sendJson(res, 200, manager.snapshot());
  }

  function handleHistory(res, url) {
    if (!eventStore) {
      sendJson(res, 503, { error: 'event_store_unavailable', detail: eventStoreError || 'disabled' });
      return;
    }
    const q = url.searchParams;
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 200));
    const result = eventStore.query({
      sessionId: q.get('sessionId') || '',
      runId: q.get('runId') || '',
      traceId: q.get('traceId') || '',
      from: Number(q.get('from')) || 0,
      to: Number(q.get('to')) || 0,
      limit,
      offset: Number(q.get('offset')) || 0,
    });
    sendJson(res, 200, { ...result, stats: eventStore.stats() });
  }

  function handleHistoryStats(res) {
    if (!eventStore) {
      sendJson(res, 503, { error: 'event_store_unavailable', detail: eventStoreError || 'disabled' });
      return;
    }
    sendJson(res, 200, { ...eventStore.stats(), integrity: eventStore.integrityCheck() });
  }

  function handleSettingsGet(res) {
    sendJson(res, 200, loadSettings(settingsFile));
  }

  async function handleSettingsPut(req, res) {
    const parsed = await parseJsonRequest(req, res, settingsBodyLimit);
    if (!parsed.ok) return;
    if (!isPlainObject(parsed.value)) {
      sendIssues(res, [{ path: '$', code: 'not_object', message: 'settings must be a JSON object' }]);
      return;
    }
    try {
      const saved = updateSettings(settingsFile, parsed.value);
      sendJson(res, 200, saved);
    } catch (error) {
      if (error && error.code === 'INVALID_SETTINGS' && Array.isArray(error.issues)) {
        sendIssues(res, error.issues);
        return;
      }
      logger.error('settings write failed:', error && error.message ? error.message : 'unknown error');
      sendJson(res, 500, { error: 'settings_write_failed' });
    }
  }

  async function handleSimulate(req, res) {
    if (!enableSimulate) {
      sendJson(res, 403, { error: 'simulate_disabled' });
      return;
    }
    const parsed = await parseJsonRequest(req, res, simulateBodyLimit);
    if (!parsed.ok) return;
    const body = isPlainObject(parsed.value) ? parsed.value : {};
    const scenario = typeof body.scenario === 'string' && body.scenario ? body.scenario : 'demo';
    if (!SCENARIO_NAMES.includes(scenario)) {
      sendIssues(res, [
        { path: 'scenario', code: 'unknown_scenario', message: `expected one of ${SCENARIO_NAMES.join(', ')}` },
      ]);
      return;
    }
    const intervalMs = Number.isFinite(body.intervalMs)
      ? Math.max(0, Math.min(10000, Number(body.intervalMs)))
      : 450;
    const sessionId =
      typeof body.sessionId === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(body.sessionId)
        ? body.sessionId
        : `simulator:http-${clock().toString(36)}`;
    const steps = scenarioSteps(scenario);
    let index = 0;
    const scheduleNext = () => {
      if (stopping || index >= steps.length) return;
      const step = steps[index];
      try {
        manager.ingest(
          buildStepEvent(step, {
            sessionId,
            timestamp: clock(),
            seq: index,
          }),
        );
      } catch (error) {
        logger.warn('simulate ingest failed:', error && error.message ? error.message : 'unknown error');
      }
      index += 1;
      if (index < steps.length && intervalMs > 0) {
        const timer = setTimeout(() => {
          simTimers.delete(timer);
          scheduleNext();
        }, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        simTimers.add(timer);
      } else if (index < steps.length) {
        scheduleNext();
      }
    };
    scheduleNext();
    sendJson(res, 202, { scenario, scheduled: steps.length, intervalMs, sessionId, source: 'simulated' });
  }

  function handleStream(req, res, url) {
    const presented = queryToken(url) || headerToken(req);
    if (!authorized(presented)) {
      sendUnauthorized(res);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const client = { res, timer: null, lastSentAt: 0, closed: false, close: null, unsubscribe: null };
    const close = () => {
      if (client.closed) return;
      client.closed = true;
      if (client.timer) {
        clearTimeout(client.timer);
        client.timer = null;
      }
      if (client.unsubscribe) {
        client.unsubscribe();
        client.unsubscribe = null;
      }
      clients.delete(client);
      try {
        res.end();
      } catch {
        /* already gone */
      }
    };
    client.close = close;
    clients.add(client);
    req.on('close', close);
    res.on('close', close);
    client.unsubscribe = manager.subscribe(() => scheduleClientUpdate(client));
    writeSse(client, 'snapshot', manager.snapshot());
  }

  function writeSse(client, eventName, data) {
    if (!client || client.closed) return false;
    try {
      client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      client.lastSentAt = clock();
      return true;
    } catch {
      if (client.close) client.close();
      return false;
    }
  }

  function scheduleClientUpdate(client) {
    if (client.closed || client.timer) return;
    const wait = Math.max(0, updateThrottleMs - (clock() - client.lastSentAt));
    client.timer = setTimeout(() => {
      client.timer = null;
      if (client.closed) return;
      writeSse(client, 'update', manager.snapshot());
    }, wait);
    if (typeof client.timer.unref === 'function') client.timer.unref();
  }

  function startPing() {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      for (const client of [...clients]) {
        if (client.closed) continue;
        try {
          client.res.write(': ping\n\n');
        } catch {
          if (client.close) client.close();
        }
      }
    }, pingIntervalMs);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      logger.error('request failed:', error && error.message ? error.message : 'unknown error');
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 500, { error: 'internal_error' });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  });
  server.on('clientError', (error, socket) => {
    logger.debug('clientError:', error && error.message ? error.message : 'unknown');
    if (socket && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  async function handleRequest(req, res) {
    securityHeaders(res);

    if (stopping) {
      sendJson(res, 503, { error: 'shutting_down' });
      return;
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'loopback_only' }, { Connection: 'close' });
      return;
    }
    if (!validHostHeader(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden_host' });
      return;
    }
    const originCheck = validateOrigin(req.headers.origin);
    if (!originCheck.ok) {
      logger.debug('rejected origin', req.headers.origin);
      sendJson(res, 403, { error: 'forbidden_origin' });
      return;
    }
    if (originCheck.allow) applyCors(res, originCheck.allow);

    if (!checkRate(req.socket)) {
      const bucket = rateBuckets.get(req.socket);
      sendRateLimited(res, bucket && bucket.retryAfterMs ? bucket.retryAfterMs : rateLimitWindowMs);
      return;
    }

    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pathname === '/v1/health') {
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        name: BRIDGE_NAME,
        version: BRIDGE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        uptimeMs: Math.max(0, clock() - startedAt),
        port: listeningPort,
      });
      return;
    }

    // SSE authenticates with the header OR ?token= (contract §6), so it owns its
    // auth check and must be routed before the global header-only gate below.
    if (pathname === '/v1/stream') {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      return handleStream(req, res, url);
    }

    const authHeader = headerToken(req);
    if (!authorized(authHeader)) {
      sendUnauthorized(res);
      return;
    }

    try {
      if (pathname === '/v1/events') {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
        return await handleEvents(req, res);
      }
      if (pathname === '/v1/state' || pathname === '/v1/stack') {
        // /v1/stack is a read-only alias kept for ad-hoc smoke tests.
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
        return handleState(res);
      }
      if (pathname === '/v1/history') {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
        return handleHistory(res, url);
      }
      if (pathname === '/v1/history/stats') {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
        return handleHistoryStats(res);
      }
      if (pathname === '/v1/settings') {
        if (req.method === 'GET') return handleSettingsGet(res);
        if (req.method === 'PUT') return await handleSettingsPut(req, res);
        return sendMethodNotAllowed(res, 'GET, PUT');
      }
      if (pathname === '/v1/simulate') {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
        return await handleSimulate(req, res);
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error && error.statusCode === 413) {
        sendPayloadTooLarge(res, error.limit || eventBodyLimit);
        return;
      }
      throw error;
    }
  }

  function info() {
    return {
      name: BRIDGE_NAME,
      version: BRIDGE_VERSION,
      host: BRIDGE_HOST,
      port: listeningPort,
      url: listeningPort === null ? null : `http://${BRIDGE_HOST}:${listeningPort}`,
    };
  }

  async function start() {
    if (server.listening) return info();
    const port = options.port === undefined ? resolvePort(env) : Number(options.port);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: BRIDGE_HOST, port, exclusive: true });
    });
    const address = server.address();
    listeningPort = address && typeof address === 'object' ? address.port : port;
    manager.start();
    startPing();
    server.on('close', () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    });
    logger.info(`listening on http://${BRIDGE_HOST}:${listeningPort}`);
    logger.info(`token file: ${tokenFile}`);
    logger.info(`settings file: ${settingsFile}`);
    return info();
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    for (const timer of simTimers) clearTimeout(timer);
    simTimers.clear();
    for (const client of [...clients]) {
      if (client.close) client.close();
    }
    manager.stop();
    try { eventStore?.close(); } catch { /* best effort */ }
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      setImmediate(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    });
    logger.info('stopped');
  }

  return {
    server,
    manager,
    settingsFile,
    tokenFile,
    start,
    stop,
    get listening() {
      return server.listening;
    },
    get port() {
      return listeningPort;
    },
    get url() {
      return listeningPort === null ? null : `http://${BRIDGE_HOST}:${listeningPort}`;
    },
    get info() {
      return info();
    },
  };
}

async function runCli() {
  let bridge;
  try {
    bridge = createBridgeServer();
    const info = await bridge.start();
    console.log(`[bridge] ready ${info.url}/v1/health`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (error && error.code === 'EADDRINUSE') {
      console.error(`[bridge] port already in use. Set HALOFLUX_BRIDGE_PORT=0 for an OS-assigned port.`);
    } else {
      console.error(`[bridge] failed to start: ${redactSecrets(message)}`);
    }
    process.exitCode = 1;
    return;
  }
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bridge] shutting down (${signal})`);
    try {
      await bridge.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  runCli().catch((error) => {
    console.error(`[bridge] fatal: ${redactSecrets(error && error.message ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
