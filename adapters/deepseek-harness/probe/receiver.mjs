/**
 * Minimal HALOFLUX Event Bridge stub for adapter verification.
 *
 * This is NOT the product bridge (`packages/event-bridge`). It implements just
 * enough of docs/architecture.md §6 to prove that a real Harness event leaves
 * the Host, is normalized to HALOFLUX event v1, passes the frozen
 * `@haloflux/event-schema` validator, and arrives over loopback with token auth.
 *
 *   node probe/receiver.mjs --port 17818 --token <hex> --out probe/evidence/received.jsonl
 *
 * Endpoints: GET /v1/health, POST /v1/events (single event or {events:[...]}).
 */
import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { validateEvent } from '../../../packages/event-schema/dist/index.js';

const MAX_BODY = 256 * 1024;
const MAX_BATCH = 100;

function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || !expected) return false;
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function headerToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const alt = req.headers['x-haloflux-token'];
  return typeof alt === 'string' ? alt : '';
}

/**
 * Create the stub bridge.
 * @param {{port?: number, token: string, outFile?: string, host?: string, quiet?: boolean}} options
 */
export async function createReceiver(options) {
  const token = String(options.token || '');
  if (!token) throw new Error('receiver requires a token');
  const outFile = options.outFile ? resolve(options.outFile) : '';
  const host = options.host || '127.0.0.1';
  const quiet = Boolean(options.quiet);
  const events = [];
  const stats = { accepted: 0, rejected: 0, authFailures: 0, sessions: new Set() };
  let writeChain = Promise.resolve();

  const persist = (event) => {
    events.push(event);
    if (!outFile) return;
    writeChain = writeChain
      .then(async () => {
        await mkdir(dirname(outFile), { recursive: true });
        await appendFile(outFile, `${JSON.stringify(event)}\n`, 'utf8');
      })
      .catch(() => {});
  };

  const server = http.createServer((req, res) => {
    const reply = (status, body, extraHeaders = {}) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, ...extraHeaders });
      res.end(payload);
    };
    try {
      if (req.method === 'GET' && req.url === '/v1/health') {
        reply(200, { ok: true, name: 'haloflux-probe-receiver', version: '0.1.0', uptimeMs: process.uptime() * 1000 });
        return;
      }
      if (req.method !== 'POST' || (req.url !== '/v1/events' && !String(req.url || '').startsWith('/v1/events?'))) {
        reply(404, { error: 'not_found' });
        return;
      }
      if (!tokenMatches(token, headerToken(req))) {
        stats.authFailures += 1;
        reply(401, { error: 'unauthorized' });
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reply(413, { error: 'payload_too_large' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BODY) return;
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          stats.rejected += 1;
          reply(400, { error: 'invalid_json' });
          return;
        }
        const candidates = Array.isArray(parsed?.events) ? parsed.events : [parsed];
        if (candidates.length === 0 || candidates.length > MAX_BATCH) {
          stats.rejected += 1;
          reply(400, { error: 'bad_batch' });
          return;
        }
        const issues = [];
        const accepted = [];
        candidates.forEach((candidate, index) => {
          const result = validateEvent(candidate);
          if (result.ok) accepted.push(result.value);
          else issues.push(...result.errors.map((issue) => ({ ...issue, path: `[${index}]${issue.path === '$' ? '' : '.'}${issue.path}` })));
        });
        if (issues.length > 0) {
          stats.rejected += issues.length;
          reply(400, { accepted: 0, issues });
          return;
        }
        for (const event of accepted) {
          stats.accepted += 1;
          stats.sessions.add(event.sessionId);
          persist(event);
        }
        reply(202, { accepted: accepted.length, duplicates: 0, sessions: stats.sessions.size });
      });
      req.on('error', () => {
        try {
          reply(400, { error: 'request_error' });
        } catch {
          /* ignore */
        }
      });
    } catch (error) {
      try {
        reply(500, { error: 'internal' });
      } catch {
        /* ignore */
      }
      if (!quiet) console.error('[receiver] handler error', error && error.message);
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 17818, host, () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  if (!quiet) console.log(`[receiver] READY http://${host}:${port}/v1/events (auth required)${outFile ? ` -> ${outFile}` : ''}`);

  return {
    server,
    port,
    stats,
    events,
    async close() {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
      await writeChain;
      return { ...stats, sessions: stats.sessions.size, events: events.length };
    },
  };
}

function parseArgs(argv) {
  const out = { port: 17818, token: '', tokenFile: '', outFile: '', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--token-file') out.tokenFile = argv[++i];
    else if (arg === '--out') out.outFile = argv[++i];
    else if (arg === '--quiet') out.quiet = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let token = args.token;
  if (!token && args.tokenFile) token = (await readFile(resolve(args.tokenFile), 'utf8')).trim();
  if (!token) {
    console.error('usage: node probe/receiver.mjs --token <hex> [--port 17818] [--out events.jsonl]');
    process.exit(2);
  }
  const receiver = await createReceiver({ port: args.port, token, outFile: args.outFile, quiet: false });
  const shutdown = async () => {
    const summary = await receiver.close();
    console.log(`[receiver] SUMMARY ${JSON.stringify(summary)}`);
  };
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/probe/receiver.mjs')) {
  main().catch((error) => {
    console.error('[receiver] fatal', error && error.message);
    process.exit(1);
  });
}
