/**
 * HALOFLUX — test bridge (mock of packages/event-bridge, for adapter validation).
 *
 * Why this exists: adapters must work against the real loopback bridge, but the
 * bridge is owned by another workstream and may not be running while adapters
 * are developed. This server speaks the same §6 contract surface an adapter
 * needs (`GET /v1/health`, `POST /v1/events`) and validates every event with the
 * **real** frozen schema (`packages/event-schema/dist/index.js`), so a synthetic
 * payload that passes here is schema-valid.
 *
 * It is a test double only: no SSE, no session manager, no settings.
 *
 * Usage:
 *   node adapters/_shared/test-bridge.mjs [--port 17818] [--token-file <p>]
 *     [--out <events.jsonl>] [--print]
 * Token resolution: $HALOFLUX_TOKEN > --token-file > generated next to the out file.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let schema;
try {
  schema = await import('../../packages/event-schema/dist/index.js');
} catch {
  schema = await import('./schema-lite.mjs');
}
const { validateEvent } = schema;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const port = Number(arg('port', '17818'));
const outFile = path.resolve(arg('out', path.join(here, '.test-bridge-events.jsonl')));
const printEach = flag('print');
const tokenFile = path.resolve(arg('token-file', path.join(here, '.test-bridge-token')));
const token = (process.env.HALOFLUX_TOKEN || '').trim() || (() => {
  try {
    if (existsSync(tokenFile)) {
      const existing = readFileSync(tokenFile, 'utf8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    mkdirSync(path.dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
})();

const startedAt = Date.now();
let eventCount = 0;
let rejected = 0;
const seen = new Set();

function authorized(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = typeof req.headers['x-haloflux-token'] === 'string' ? req.headers['x-haloflux-token'].trim() : '';
  return bearer === token || alt === token;
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    sendJson(res, 200, {
      ok: true, name: 'haloflux-test-bridge', version: '0.1.0-test', uptimeMs: Date.now() - startedAt,
      adapterTestDouble: true,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/stats') {
    if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    sendJson(res, 200, { eventCount, rejected, uptimeMs: Date.now() - startedAt });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/events') {
    if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      sendJson(res, error.code === 'too_large' ? 413 : 400, { error: 'bad_body' });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid_json' }); return; }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [parsed];
    if (list.length === 0 || list.length > 100) { sendJson(res, 400, { error: 'bad_batch' }); return; }
    const issues = [];
    const accepted = [];
    list.forEach((candidate, index) => {
      const result = validateEvent(candidate);
      if (result.ok) accepted.push(result.value);
      else {
        rejected += 1;
        issues.push(...result.errors.map((e) => ({ ...e, path: `[${index}]${e.path}` })));
      }
    });
    if (issues.length > 0) { sendJson(res, 400, { issues }); return; }
    let duplicates = 0;
    for (const event of accepted) {
      if (seen.has(event.eventId)) { duplicates += 1; continue; }
      seen.add(event.eventId);
      eventCount += 1;
      const line = JSON.stringify({ receivedAt: new Date().toISOString(), event });
      try { appendFileSync(outFile, `${line}\n`, 'utf8'); } catch { /* test double */ }
      if (printEach) process.stdout.write(`${line}\n`);
    }
    process.stdout.write(`[test-bridge] accepted=${accepted.length} duplicates=${duplicates} total=${eventCount}\n`);
    sendJson(res, 202, { accepted: accepted.length, duplicates, sessions: new Set(accepted.map((e) => e.sessionId)).size });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[test-bridge] listening http://127.0.0.1:${port} tokenFile=${tokenFile} out=${outFile}\n`);
  if (!process.env.HALOFLUX_TOKEN) process.stdout.write(`[test-bridge] token written to ${tokenFile} (never printed)\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`[test-bridge] stopping (events=${eventCount}, rejected=${rejected})\n`);
    server.close(() => process.exit(0));
  });
}
