#!/usr/bin/env node
/**
 * P2 security probe (sec-perf acceptance gate).
 *
 * Runs the REAL bridge (packages/event-bridge/src/server.mjs) as a child
 * process on an isolated 180xx loopback port with a throwaway HALOFLUX_HOME,
 * then asserts the security invariants from docs/03-security-and-license.md and
 * docs/architecture.md §10 with raw HTTP/SSE so headers, bodies and sockets are
 * under our control.
 *
 * The production port 17817 is never touched. No source file is modified; the
 * only writes are the evidence JSON + the captured bridge log next to this file.
 *
 * Usage: node tests/evidence/p2-security/probe.mjs
 * Exit: 0 all checks pass, 1 any failure, 2 harness error.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BRIDGE_ENTRY = path.join(ROOT, 'packages', 'event-bridge', 'src', 'server.mjs');
const OUT_JSON = path.join(HERE, 'security-probe.json');
const OUT_LOG = path.join(HERE, 'bridge-debug.log');

const importFile = (relativePath) => import(pathToFileURL(path.join(ROOT, relativePath)).href);

const { createEvent, MAX_BATCH } = await importFile('packages/event-schema/dist/index.js');
const { rawRequest, tcpReachable } = await importFile('tests/helpers/http.mjs');
const { createLogger } = await importFile('packages/event-bridge/src/server.mjs');

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

const checks = [];
const collectedBodies = [];
const bridgeBodies = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(id, category, description, fn) {
  const started = Date.now();
  try {
    const observed = (await fn()) || {};
    const status = observed.skipped ? 'SKIP' : 'PASS';
    const entry = { id, category, description, status, ms: Date.now() - started, observed };
    checks.push(entry);
    console.log(`[${status}] ${id} — ${description} (${entry.ms}ms)`);
    return observed;
  } catch (error) {
    const entry = {
      id,
      category,
      description,
      status: 'FAIL',
      ms: Date.now() - started,
      error: error && error.message ? error.message : String(error),
    };
    checks.push(entry);
    console.log(`[FAIL] ${id} — ${entry.error}`);
    return null;
  }
}

function nonLoopbackIPv4() {
  const found = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info && info.family === 'IPv4' && !info.internal) found.push(info.address);
    }
  }
  return found;
}

async function freePort() {
  for (let i = 0; i < 200; i += 1) {
    const port = 18010 + Math.floor(Math.random() * 90);
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port in 18010-18099');
}

function tail(text, max = 2000) {
  if (!text) return '';
  return text.length > max ? `…${text.slice(-max)}` : text;
}

async function startBridge(port, home, token) {
  const childEnv = {
    ...process.env,
    HALOFLUX_BRIDGE_PORT: String(port),
    HALOFLUX_HOME: home,
    HALOFLUX_LOG_LEVEL: 'debug',
    NO_COLOR: '1',
  };
  if (token) childEnv.HALOFLUX_TOKEN = token;
  else delete childEnv.HALOFLUX_TOKEN;
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`bridge exited before health\nstdout:${tail(stdout)}\nstderr:${tail(stderr)}`);
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/v1/health', method: 'GET', agent: false, timeout: 900 },
          (response) => {
            const chunks = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });
      if (res.status === 200) break;
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    token,
    home,
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    },
  };
}

let seq = 0;
function mkEvent(overrides = {}) {
  seq += 1;
  return createEvent({
    host: 'deepseek-harness',
    sessionId: 'sess-sec-probe',
    eventType: 'run.start',
    hostVersion: 'p2-probe-1.0',
    timestamp: Date.now(),
    eventId: `evt-p2probe-${Date.now().toString(36)}-${seq}`,
    ...overrides,
  });
}

function jsonPost(port, token, pathname, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return rawRequest({
    port,
    method: 'POST',
    path: pathname,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...headers,
    },
    body: payload,
    timeoutMs: 15000,
  }).then((res) => {
    bridgeBodies.push(res.body);
    return res;
  });
}

function getJson(port, token, pathname, headers = {}) {
  return rawRequest({
    port,
    method: 'GET',
    path: pathname,
    headers: { authorization: `Bearer ${token}`, ...headers },
    timeoutMs: 8000,
  }).then((res) => {
    bridgeBodies.push(res.body);
    return res;
  });
}

/* ------------------------------------------------------------------ *
 * raw SSE reader (snapshot + updates)
 * ------------------------------------------------------------------ */

function openSse(port, token, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `/v1/stream?token=${encodeURIComponent(token)}`,
        headers: { accept: 'text/event-stream' },
        agent: false,
      },
      (res) => {
        const state = { status: res.statusCode, headers: res.headers, frames: [], buffer: '', closed: false };
        res.setEncoding('utf8');
        const finish = (error) => {
          if (state.closed) return;
          state.closed = true;
          clearTimeout(timer);
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
          if (error) reject(error);
          else resolve(state);
        };
        const timer = setTimeout(() => finish(), timeoutMs);
        res.on('data', (chunk) => {
          state.buffer += chunk;
          let index = state.buffer.indexOf('\n\n');
          while (index >= 0) {
            const frame = state.buffer.slice(0, index);
            state.buffer = state.buffer.slice(index + 2);
            const eventMatch = /^event:\s*(.+)$/m.exec(frame);
            const dataLines = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''));
            if (dataLines.length > 0) {
              state.frames.push({ event: eventMatch ? eventMatch[1].trim() : 'message', data: dataLines.join('\n') });
            }
            index = state.buffer.indexOf('\n\n');
          }
          if (state.frames.length > 0) finish();
        });
        res.on('end', () => finish());
        res.on('error', (error) => finish(error));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 429 rate-limit probe: pipelined requests on ONE socket
 * ------------------------------------------------------------------ */

function pipeline(socketPort, count, pathname = '/v1/health') {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: socketPort });
    const payload = Array.from(
      { length: count },
      () => `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${socketPort}\r\nConnection: keep-alive\r\n\r\n`,
    ).join('');
    let buffer = '';
    const statuses = [];
    const timings = { start: Date.now() };
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({
        statuses,
        elapsedMs: Date.now() - timings.start,
        retryAfterSeen: /retry-after:\s*1/i.test(buffer),
        rateLimited: statuses.filter((s) => s === 429).length,
        ok: statuses.filter((s) => s === 200).length,
      });
    };
    const timer = setTimeout(finish, 10000);
    socket.setEncoding('latin1');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const matches = [...chunk.matchAll(/HTTP\/1\.1 (\d{3})/g)];
      for (const match of matches) statuses.push(Number(match[1]));
      if (statuses.length >= count) finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(BRIDGE_ENTRY)) {
    console.error(`bridge entry missing: ${BRIDGE_ENTRY}`);
    process.exit(2);
  }
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-p2sec-'));
  const token = 'c0ffee'.repeat(10) + 'beef'; // 64 hex, distinctive so redaction is provable
  const wrongToken = 'deadbeef'.repeat(8);
  const bridge = await startBridge(port, home, token);
  const base = bridge.base;
  const bearer = { authorization: `Bearer ${token}` };

  const evidence = {
    schema: 'haloflux.p2.security.probe.v1',
    generatedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpu: os.cpus()?.[0]?.model ?? 'unknown',
      cores: os.cpus()?.length ?? 0,
      node: process.version,
    },
    bridge: {
      entry: path.relative(ROOT, BRIDGE_ENTRY),
      port,
      portRange: '18010-18099 (isolated; production 17817 untouched)',
      home,
      logLevel: 'debug',
      tokenMask: `sha256:${(await import('node:crypto')).createHash('sha256').update(token).digest('hex').slice(0, 12)}… (64 chars). Raw token is never written to evidence.`,
      pid: bridge.child.pid,
    },
    checks,
    summary: {},
  };

  console.log(`[probe] bridge pid=${bridge.child.pid} port=${port} home=${home}`);

  /* ---------------- S1: loopback binding, netstat ---------------- */
  await check(
    'S1-loopback-bind',
    'network',
    'Bridge listens on 127.0.0.1 only (Windows listener table + non-loopback IPv4/IPv6 unreachable)',
    async () => {
      // Reachability is the authoritative test: a 127.0.0.1 bind must be
      // unreachable from every non-internal interface, IPv4 and IPv6.
      const addresses = nonLoopbackIPv4();
      const reachable = [];
      for (const address of addresses.slice(0, 4)) {
        if (await tcpReachable(address, port, 1200)) reachable.push(address);
      }
      const ipv6Reachable = await tcpReachable('::1', port, 1200);
      assert(reachable.length === 0, `reachable on non-loopback IPv4: ${reachable.join(',')}`);
      assert(ipv6Reachable === false, 'reachable on ::1 although the bridge binds 127.0.0.1');

      // Windows' own listener table. In this sandboxed harness the CIM/netstat
      // view is virtualized (Get-NetTCPConnection reported no entry for a port we
      // were actively talking to; netstat shows only a filtered set with PIDs
      // redacted to 0), so the table is recorded as corroboration and the
      // bind-probe below is the authoritative binding proof.
      let listeners = [];
      let listenerSource = 'Get-NetTCPConnection';
      let listenerError = null;
      try {
        const raw = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`,
          ],
          { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        listeners = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(listeners)) listeners = [listeners];
      } catch (error) {
        listenerError = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 200);
        listenerSource = 'netstat';
        const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        listeners = netstat
          .split(/\r?\n/)
          .filter((line) => line.includes(`:${port}`) && /LISTEN/i.test(line))
          .map((line) => {
            const fields = line.trim().replace(/\s+/g, ' ').split(' ');
            return { LocalAddress: fields[1].replace(/:\d+$/, ''), LocalPort: port, OwningProcess: Number(fields[4]) };
          });
      }

      // Authoritative bind probe: Windows rejects a second bind on the same
      // address:port, so "127.0.0.1 busy" + "this host IP free" proves the bridge
      // owns loopback only and did not open a wildcard/non-loopback listener.
      const canBind = (host, bindPort) =>
        new Promise((resolve) => {
          const server = net.createServer();
          server.unref();
          server.once('error', (error) => resolve({ host, ok: false, code: error && error.code }));
          server.listen({ host, port: bindPort, exclusive: true }, () => server.close(() => resolve({ host, ok: true })));
        });
      const loopbackBind = await canBind('127.0.0.1', port);
      assert(loopbackBind.ok === false && loopbackBind.code === 'EADDRINUSE', `127.0.0.1:${port} was free — nothing is bound to loopback`);
      const probeAddress = addresses[0];
      const hostBind = probeAddress ? await canBind(probeAddress, port) : { skipped: true };
      if (!hostBind.skipped) {
        assert(hostBind.ok === true, `non-loopback ${probeAddress}:${port} was already in use — bridge may be bound broadly (${hostBind.code})`);
      }
      const nonLoopbackListeners = listeners.filter((entry) => entry.LocalAddress !== '127.0.0.1' && entry.LocalAddress !== '::1');
      assert(nonLoopbackListeners.length === 0, `Windows table shows non-loopback listener(s): ${JSON.stringify(nonLoopbackListeners)}`);
      return {
        listenerSource,
        listeners,
        listenerError,
        loopbackBind,
        hostBind,
        nonLoopbackIPv4: addresses,
        reachableIPv4: reachable,
        ipv6Reachable,
        note: 'CIM/netstat are virtualized in this sandbox; reachability + bind-probe are authoritative.',
      };
    },
  );

  /* ---------------- S2: auth required on every endpoint ---------------- */
  await check('S2-auth-required', 'auth', 'Every /v1 endpoint except /v1/health returns 401 without a token', async () => {
    const cases = [
      ['GET', '/v1/state'],
      ['GET', '/v1/stack'],
      ['GET', '/v1/settings'],
      ['GET', '/v1/stream'],
      ['POST', '/v1/events', JSON.stringify(mkEvent())],
      ['POST', '/v1/simulate', JSON.stringify({ scenario: 'demo' })],
    ];
    const results = [];
    for (const [method, pathname, body] of cases) {
      const res = await rawRequest({
        port,
        method,
        path: pathname,
        headers: { 'content-type': 'application/json' },
        body,
        timeoutMs: 8000,
      });
      bridgeBodies.push(res.body);
      results.push({ method, pathname, status: res.status, body: res.body.slice(0, 120) });
      assert(res.status === 401, `${method} ${pathname} without token expected 401, got ${res.status}`);
    }
    return { results };
  });

  /* ---------------- S3: wrong token 401, no echo ---------------- */
  await check('S3-wrong-token', 'auth', 'Wrong / malformed token → 401 and the presented token is never echoed', async () => {
    const results = [];
    for (const pathname of ['/v1/state', '/v1/settings', '/v1/stack']) {
      const res = await rawRequest({ port, path: pathname, headers: { authorization: `Bearer ${wrongToken}` } });
      bridgeBodies.push(res.body);
      results.push({ pathname, status: res.status });
      assert(res.status === 401, `${pathname} wrong token expected 401, got ${res.status}`);
      assert(!res.body.includes(wrongToken), `${pathname} echoed the presented token`);
      assert(!res.body.includes(token), `${pathname} echoed the real token`);
    }
    const malformed = await rawRequest({ port, path: '/v1/state', headers: { authorization: 'Bearer' } });
    const empty = await rawRequest({ port, path: '/v1/state', headers: { authorization: 'Bearer ' } });
    const alternateWrong = await rawRequest({ port, path: '/v1/state', headers: { 'x-haloflux-token': wrongToken } });
    results.push({ pathname: '/v1/state', variant: 'malformed', status: malformed.status });
    results.push({ pathname: '/v1/state', variant: 'empty', status: empty.status });
    results.push({ pathname: '/v1/state', variant: 'x-haloflux-token', status: alternateWrong.status });
    for (const res of [malformed, empty, alternateWrong]) {
      bridgeBodies.push(res.body);
      assert(res.status === 401, `variant expected 401, got ${res.status}`);
    }
    return { results };
  });

  /* ---------------- S4: query token only for SSE ---------------- */
  await check('S4-query-token-scope', 'auth', '?token= authenticates /v1/stream only, not other endpoints', async () => {
    const stateViaQuery = await rawRequest({ port, path: `/v1/state?token=${encodeURIComponent(token)}` });
    const settingsViaQuery = await rawRequest({ port, path: `/v1/settings?token=${encodeURIComponent(token)}` });
    bridgeBodies.push(stateViaQuery.body, settingsViaQuery.body);
    assert(stateViaQuery.status === 401, `/v1/state?token= should be 401, got ${stateViaQuery.status}`);
    assert(settingsViaQuery.status === 401, `/v1/settings?token= should be 401, got ${settingsViaQuery.status}`);
    const sse = await openSse(port, token, { timeoutMs: 4000 });
    assert(sse.status === 200, `SSE with ?token= expected 200, got ${sse.status}`);
    assert(sse.frames.length > 0, 'SSE did not deliver a snapshot frame');
    const badSse = await rawRequest({ port, path: '/v1/stream?token=nope', timeoutMs: 4000 });
    bridgeBodies.push(badSse.body);
    assert(badSse.status === 401, `SSE wrong query token expected 401, got ${badSse.status}`);
    return {
      stateViaQuery: stateViaQuery.status,
      settingsViaQuery: settingsViaQuery.status,
      sseQueryToken: sse.status,
      sseFirstFrame: sse.frames[0]?.event ?? null,
      sseWrongQueryToken: badSse.status,
    };
  });

  /* ---------------- S5: Origin / Host rejection ---------------- */
  await check('S5-origin-host', 'network', 'Non-loopback Origin and Host are rejected; loopback/file/null Origin allowed', async () => {
    const results = [];
    for (const origin of ['https://evil.example.com', 'http://127.0.0.1.evil.example', 'http://10.0.0.1:8080', 'http://localhost.evil.example:3000']) {
      const res = await rawRequest({
        port,
        method: 'POST',
        path: '/v1/events',
        headers: { ...bearer, origin, 'content-type': 'application/json', 'content-length': '0' },
        body: '',
      });
      bridgeBodies.push(res.body);
      results.push({ kind: 'origin', value: origin, status: res.status });
      assert(res.status === 403, `Origin ${origin} expected 403, got ${res.status}`);
      assert(!res.body.includes(token), 'Origin rejection leaked the token');
    }
    for (const origin of ['null', 'file://', `http://127.0.0.1:${port}`, 'http://localhost:3000']) {
      const res = await jsonPost(port, token, '/v1/events', mkEvent(), { origin });
      results.push({ kind: 'origin-allowed', value: origin, status: res.status });
      assert(res.status === 202, `Origin ${origin} expected 202, got ${res.status}: ${res.body.slice(0, 200)}`);
    }
    for (const host of ['evil.example.com', '127.0.0.1.evil.example', 'localhost.evil.example', '0.0.0.0']) {
      const res = await rawRequest({ port, path: '/v1/state', headers: { ...bearer, host: `${host}:${port}` } });
      bridgeBodies.push(res.body);
      results.push({ kind: 'host', value: host, status: res.status });
      assert(res.status === 403, `Host ${host} expected 403, got ${res.status}`);
    }
    const local = await rawRequest({ port, path: '/v1/state', headers: { ...bearer, host: `127.0.0.1:${port}` } });
    const localhost = await rawRequest({ port, path: '/v1/state', headers: { ...bearer, host: `localhost:${port}` } });
    assert(local.status === 200, `loopback Host expected 200, got ${local.status}`);
    assert(localhost.status === 200, `localhost Host expected 200, got ${localhost.status}`);
    return { results, loopbackHost: local.status, localhostHost: localhost.status };
  });

  /* ---------------- S6: 413 oversized ---------------- */
  await check('S6-oversized-413', 'limits', '>256 KB body → 413 (declared content-length and chunked/streamed)', async () => {
    const declared = JSON.stringify({ events: [], padding: 'x'.repeat(300 * 1024) });
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: { ...bearer, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(declared)) },
      body: declared,
      timeoutMs: 15000,
    });
    bridgeBodies.push(res.body);
    assert(res.status === 413, `declared 300 KB expected 413, got ${res.status}`);

    const chunked = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(value);
      };
      const guard = setTimeout(() => done({ status: null, body: 'chunked 413 probe timed out' }), 10000);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/events',
          headers: { ...bearer, 'content-type': 'application/json' },
          agent: false,
        },
        (response) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', (error) => {
        if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) return; // server already answered
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          reject(error);
        }
      });
      let sent = 0;
      const pump = () => {
        if (sent >= 12) {
          try {
            req.end();
          } catch {
            /* done */
          }
          return;
        }
        sent += 1;
        try {
          req.write(Buffer.alloc(32 * 1024, 0x78));
        } catch {
          /* server closed early */
        }
        setImmediate(pump);
      };
      pump();
    });
    bridgeBodies.push(chunked.body);
    assert(chunked.status === 413, `chunked 384 KB expected 413, got ${chunked.status}`);
    const health = await rawRequest({ port, path: '/v1/health' });
    assert(health.status === 200, 'bridge not healthy after oversized bodies');
    return { declaredStatus: res.status, declaredBody: res.body.slice(0, 160), chunkedStatus: chunked.status, healthAfter: health.status };
  });

  /* ---------------- S7: batch / event size limits ---------------- */
  await check('S7-batch-event-limits', 'limits', `>${MAX_BATCH} events/batch and >8 KB serialized events are rejected (400), bridge stays alive`, async () => {
    const tooMany = { events: Array.from({ length: MAX_BATCH + 1 }, () => mkEvent()) };
    const batchRes = await jsonPost(port, token, '/v1/events', tooMany);
    assert(batchRes.status === 400, `batch of ${MAX_BATCH + 1} expected 400, got ${batchRes.status}`);
    // A single event cannot exceed 8 KB through valid fields (each string is capped),
    // so exceed it with an over-long metadata string: the validator must reject it.
    const bigEvent = mkEvent();
    bigEvent.metadata = { sessionTitle: 'z'.repeat(9000) };
    const bigBytes = Buffer.byteLength(JSON.stringify({ events: [bigEvent] }));
    const bigRes = await jsonPost(port, token, '/v1/events', { events: [bigEvent] });
    assert(bigBytes > 8 * 1024, `fixture is only ${bigBytes} bytes`);
    assert(bigRes.status === 400, `9 KB event expected 400, got ${bigRes.status}`);
    const protoEvent = JSON.stringify({ events: [mkEvent()] }).replace('"metadata":{}', '"metadata":{"__proto__":{"polluted":true}}');
    assert(protoEvent.includes('"__proto__"'), 'proto fixture was not injected');
    const proto = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/events',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: protoEvent,
    });
    bridgeBodies.push(proto.body);
    assert(proto.status === 400, `__proto__ metadata expected 400, got ${proto.status}`);
    const health = await rawRequest({ port, path: '/v1/health' });
    assert(health.status === 200, 'bridge not healthy after limit violations');
    return {
      batchStatus: batchRes.status,
      batchIssues: batchRes.body.slice(0, 200),
      bigEventBytes: bigBytes,
      bigEventStatus: bigRes.status,
      bigEventIssues: bigRes.body.slice(0, 200),
      protoStatus: proto.status,
      healthAfter: health.status,
    };
  });

  /* ---------------- S8: 429 rate limit ---------------- */
  await check('S8-rate-limit-429', 'limits', 'Frequent requests on one socket → 429 with Retry-After', async () => {
    const result = await pipeline(port, 400);
    assert(result.statuses.length >= 380, `expected >=380 responses, got ${result.statuses.length}`);
    assert(result.rateLimited > 0, `no 429 observed (statuses: ${JSON.stringify(result.statuses.slice(0, 12))}…)`);
    assert(result.retryAfterSeen, '429 response missing Retry-After header');
    assert(result.ok > 0, 'no successful requests at all');
    bridgeBodies.push(`pipeline statuses 200=${result.ok} 429=${result.rateLimited}`);
    return { attempted: 400, responses: result.statuses.length, ok200: result.ok, rateLimited429: result.rateLimited, elapsedMs: result.elapsedMs, retryAfterSeen: result.retryAfterSeen };
  });

  await check('S9-rate-limit-recovery', 'limits', 'A fresh socket is not locked out after the 429 burst (limit is per socket)', async () => {
    const res = await rawRequest({ port, path: '/v1/health' });
    assert(res.status === 200, `fresh socket health expected 200, got ${res.status}`);
    const state = await getJson(port, token, '/v1/state');
    assert(state.status === 200, `fresh socket /v1/state expected 200, got ${state.status}`);
    return { healthStatus: res.status, stateStatus: state.status };
  });

  /* ---------------- S10: path traversal ---------------- */
  await check('S10-path-traversal', 'injection', 'Path traversal in URL/query cannot read files in HALOFLUX_HOME and leaks nothing', async () => {
    // Canary: a distinctive file in the isolated home that traversal would try to
    // reach if the bridge ever resolved a path from the request.
    const canaryName = 'canary-secret-store.json';
    const canary = 'CANARY-7b1e9d0c-DO-NOT-LEAK';
    fs.writeFileSync(path.join(home, canaryName), JSON.stringify({ canary }), 'utf8');
    const tokenFile = path.join(home, 'token');
    const fileToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    const homeFiles = fs.readdirSync(home);
    const cases = [
      '/v1/stream?token=../../token',
      '/v1/stream?token=..%2F..%2Ftoken',
      '/v1/stream?token=%2e%2e%2f%2e%2e%2ftoken',
      '/v1/stream?token=..%5c..%5ctoken',
      `/v1/stream?token=../../${canaryName}`,
      '/v1/stream?token=../../../../../../Windows/win.ini',
      '/../token',
      '/..%2Ftoken',
      '/v1/../token',
      '/v1/state/../../token',
      `/v1/stream?token=../${canaryName}`,
      '/v1/stream?token=',
    ];
    const results = [];
    for (const pathname of cases) {
      const res = await rawRequest({ port, path: pathname, headers: pathname.includes('/v1/state/') ? bearer : {}, timeoutMs: 5000 });
      bridgeBodies.push(res.body);
      results.push({ pathname, status: res.status });
      assert([400, 401, 403, 404].includes(res.status), `${pathname} expected 4xx, got ${res.status}`);
      if (fileToken) assert(!res.body.includes(fileToken), `${pathname} leaked the token file contents`);
      assert(!res.body.includes(token), `${pathname} leaked the real token`);
      assert(!res.body.includes(canary), `${pathname} leaked the canary file contents`);
      assert(!res.body.includes(canaryName), `${pathname} leaked the canary filename`);
      for (const file of homeFiles) {
        if (file.length > 3) assert(!res.body.includes(file), `${pathname} leaked filename ${file}`);
      }
      assert(!/\[extensions\]|win\.ini/i.test(res.body), `${pathname} leaked Windows file content`);
    }
    const traversalWithAuth = await getJson(port, token, '/v1/state/../../token');
    assert([404, 401].includes(traversalWithAuth.status), `authenticated traversal expected 404/401, got ${traversalWithAuth.status}`);
    fs.rmSync(path.join(home, canaryName), { force: true });
    return { cases: results, authenticatedTraversal: traversalWithAuth.status, homeFiles, canaryFileName: canaryName, canaryLeaked: false };
  });

  /* ---------------- S11: duplicate / replay idempotence ---------------- */
  await check('S11-duplicate-idempotence', 'integrity', 'Replaying the same eventId is counted as duplicate and does not change state', async () => {
    const sessionId = 'sess-idem-probe';
    const first = mkEvent({ sessionId, eventType: 'run.start', metadata: { step: 1, model: 'idem-model' } });
    const beforeState = await getJson(port, token, '/v1/state');
    const before = JSON.parse(beforeState.body);
    const res1 = await jsonPost(port, token, '/v1/events', { events: [first] });
    const afterFirst = JSON.parse((await getJson(port, token, '/v1/state')).body);
    const res2 = await jsonPost(port, token, '/v1/events', { events: [first] });
    const afterSecond = JSON.parse((await getJson(port, token, '/v1/state')).body);
    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    assert(res1.status === 202 && res2.status === 202, `both replays expected 202, got ${res1.status}/${res2.status}`);
    assert(body1.accepted === 1 && body1.duplicates === 0, `first delivery expected accepted=1 duplicates=0, got ${JSON.stringify(body1)}`);
    assert(body2.accepted === 0 && body2.duplicates === 1, `replay expected accepted=0 duplicates=1, got ${JSON.stringify(body2)}`);
    const sessionBefore = afterFirst.sessions.find((s) => s.sessionId === sessionId);
    const sessionAfter = afterSecond.sessions.find((s) => s.sessionId === sessionId);
    assert(sessionBefore && sessionAfter, 'replay session missing from state');
    assert(sessionAfter.eventCount === sessionBefore.eventCount, `eventCount changed on replay (${sessionBefore.eventCount} → ${sessionAfter.eventCount})`);
    assert(sessionAfter.metrics.step === sessionBefore.metrics.step, 'metrics changed on replay');
    assert(afterSecond.bridge.eventCount === afterFirst.bridge.eventCount, 'global eventCount changed on replay');
    return {
      first: body1,
      replay: body2,
      sessionEventCountStable: sessionAfter.eventCount === sessionBefore.eventCount,
      globalEventCountStable: afterSecond.bridge.eventCount === afterFirst.bridge.eventCount,
      bridgeDuplicates: afterSecond.bridge.duplicates,
      stateBeforeSessions: before.sessions.length,
    };
  });

  /* ---------------- S12: SSE reconnect ---------------- */
  await check('S12-sse-reconnect', 'resilience', 'SSE reconnect (3 cycles, abrupt close) always yields a snapshot and leaves state intact', async () => {
    const beforeState = JSON.parse((await getJson(port, token, '/v1/state')).body);
    const cycles = [];
    for (let i = 0; i < 3; i += 1) {
      const sse = await openSse(port, token, { timeoutMs: 5000 });
      const snapshotFrame = sse.frames.find((frame) => frame.event === 'snapshot');
      const snapshot = snapshotFrame ? JSON.parse(snapshotFrame.data) : null;
      cycles.push({ cycle: i + 1, status: sse.status, frames: sse.frames.length, sessions: snapshot?.sessions?.length ?? null });
      assert(sse.status === 200, `reconnect ${i + 1} expected 200, got ${sse.status}`);
      assert(snapshotFrame, `reconnect ${i + 1} did not receive a snapshot frame`);
      assert(snapshot && Array.isArray(snapshot.sessions), `reconnect ${i + 1} snapshot malformed`);
      // abrupt close: destroy the socket without the SSE close handshake
    }
    const afterState = JSON.parse((await getJson(port, token, '/v1/state')).body);
    assert(afterState.sessions.length >= beforeState.sessions.length, 'sessions lost across reconnects');
    const health = await rawRequest({ port, path: '/v1/health' });
    assert(health.status === 200, 'bridge unhealthy after reconnects');
    return { cycles, sessionsBefore: beforeState.sessions.length, sessionsAfter: afterState.sessions.length, healthAfter: health.status };
  });

  /* ---------------- S13: XSS ingress (bridge side) ---------------- */
  const xssPayload = '<img src=x onerror="window.__xss=1">';
  await check('S13-xss-ingress', 'injection', 'Bridge schema accepts untrusted label/toolName text (no charset filter) — payload reaches /v1/state verbatim', async () => {
    const validation = createEvent({
      host: 'deepseek-harness',
      sessionId: 'sess-xss-probe',
      eventType: 'tool.start',
      hostVersion: 'p2-probe-1.0',
      timestamp: Date.now(),
      eventId: 'evt-xss-payload-0001',
      metadata: { toolName: xssPayload, label: '<svg onload="window.__xss=2"></svg>' },
    });
    const res = await jsonPost(port, token, '/v1/events', { events: [validation] });
    assert(res.status === 202, `XSS payload event expected 202, got ${res.status}: ${res.body.slice(0, 200)}`);
    const state = JSON.parse((await getJson(port, token, '/v1/state')).body);
    const session = state.sessions.find((s) => s.sessionId === 'sess-xss-probe');
    assert(session, 'XSS session missing from /v1/state');
    const recent = session.recentEvents.find((e) => e.toolName === xssPayload);
    assert(recent, 'toolName payload did not survive to /v1/state (was it escaped?)');
    return {
      schemaAccepted: true,
      payloadLength: xssPayload.length,
      echoedVerbatimInState: Boolean(recent),
      note: 'Renderer must therefore render event metadata as text only; proven by electron-probe XSS task.',
    };
  });

  /* ---------------- S14: static renderer injection scan ---------------- */
  await check('S14-renderer-static-scan', 'injection', 'Renderer source contains no innerHTML/insertAdjacentHTML/document.write/eval sinks', async () => {
    const files = ['app.js', 'mock-session.js', 'monitor-projection.mjs', 'obsidian-metadata.mjs', 'index.html'];
    const patterns = [
      ['innerHTML', /\.innerHTML\s*=/],
      ['outerHTML', /\.outerHTML\s*=/],
      ['insertAdjacentHTML', /insertAdjacentHTML/],
      ['document.write', /document\.write/],
      ['eval', /(^|[^.\w])eval\s*\(/],
      ['new Function', /new\s+Function\s*\(/],
    ];
    const findings = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, 'apps', 'companion', 'renderer', file), 'utf8');
      for (const [name, re] of patterns) {
        if (re.test(text)) findings.push({ file, sink: name });
      }
    }
    assert(findings.length === 0, `unsafe DOM sinks found: ${JSON.stringify(findings)}`);
    const html = fs.readFileSync(path.join(ROOT, 'apps', 'companion', 'renderer', 'index.html'), 'utf8');
    const csp = /http-equiv="Content-Security-Policy"/.test(html) && /connect-src[^"]*127\.0\.0\.1/.test(html) && /object-src 'none'/.test(html);
    assert(csp, 'renderer index.html is missing the loopback CSP');
    return { filesScanned: files.length, sinksChecked: patterns.length, findings, cspPresent: csp };
  });

  /* ---------------- S15: security headers ---------------- */
  await check('S15-security-headers', 'hardening', 'Responses set nosniff / no-store / no-referrer and no ACAO for rejected origins', async () => {
    const ok = await rawRequest({ port, path: '/v1/health' });
    assert(ok.headers['x-content-type-options'] === 'nosniff', 'missing X-Content-Type-Options');
    assert(/no-store/.test(ok.headers['cache-control'] || ''), 'missing Cache-Control: no-store');
    assert(ok.headers['referrer-policy'] === 'no-referrer', 'missing Referrer-Policy');
    const evil = await rawRequest({ port, path: '/v1/state', headers: { ...bearer, origin: 'https://evil.example.com' } });
    assert(evil.status === 403, 'evil origin not rejected');
    assert(!evil.headers['access-control-allow-origin'], 'rejected origin received an ACAO header');
    const good = await rawRequest({ port, path: '/v1/state', headers: { ...bearer, origin: 'null' } });
    assert(good.headers['access-control-allow-origin'] === 'null', 'allowed origin missing ACAO');
    return {
      health: {
        'x-content-type-options': ok.headers['x-content-type-options'],
        'cache-control': ok.headers['cache-control'],
        'referrer-policy': ok.headers['referrer-policy'],
      },
      evilOriginAcao: evil.headers['access-control-allow-origin'] ?? null,
      nullOriginAcao: good.headers['access-control-allow-origin'] ?? null,
    };
  });

  /* ---------------- S16: token never in any response body ---------------- */
  await check('S16-no-token-echo', 'auth', 'No response body collected during the probe contains the real or presented token', async () => {
    const all = [...bridgeBodies, ...collectedBodies];
    const leaks = all.filter((body) => body.includes(token) || body.includes(wrongToken));
    assert(leaks.length === 0, `${leaks.length} response bodies leaked a token`);
    return { bodiesScanned: all.length, leaks: leaks.length };
  });

  /* ---------------- S17: log redaction (live bridge) ---------------- */
  await check('S17-log-redaction-live', 'logging', 'Bridge debug log contains no token / 64-hex secret after 401/403/404/traversal traffic', async () => {
    // New traffic designed to be logged: rejected origin (debug log) + 404 + aborted request.
    await rawRequest({ port, path: '/v1/state', headers: { ...bearer, origin: 'https://evil.example.com' } });
    await rawRequest({ port, path: '/v1/does-not-exist', headers: bearer });
    await rawRequest({ port, path: `/v1/state?token=${encodeURIComponent(token)}` });
    await sleep(400);
    const combined = `${bridge.stdout}\n${bridge.stderr}`;
    fs.writeFileSync(OUT_LOG, combined, 'utf8');
    assert(combined.includes('rejected origin'), 'expected the rejected-origin debug log line (redaction evidence incomplete)');
    assert(!combined.includes(token), 'bridge log contains the real token');
    assert(!combined.includes(wrongToken), 'bridge log contains a presented token');
    const hex = combined.match(/[0-9a-f]{64}/gi) ?? [];
    assert(hex.length === 0, `bridge log contains ${hex.length} 64-hex sequence(s): ${hex.slice(0, 2).join(',')}`);
    return {
      logPath: path.relative(ROOT, OUT_LOG),
      logBytes: Buffer.byteLength(combined),
      lines: combined.split(/\r?\n/).filter(Boolean).length,
      redactedMarkers: (combined.match(/\[redacted\]/g) ?? []).length,
      hasRejectedOriginLine: combined.includes('rejected origin'),
      tokenOccurrences: combined.split(token).length - 1,
      hex64Occurrences: hex.length,
    };
  });

  /* ---------------- S18: log redaction (logger unit) ---------------- */
  await check('S18-log-redaction-unit', 'logging', 'createLogger redacts explicit secrets and every 64-hex token in all levels', async () => {
    const captured = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args) => captured.push(args.join(' '));
    console.warn = (...args) => captured.push(args.join(' '));
    console.error = (...args) => captured.push(args.join(' '));
    try {
      const logger = createLogger('debug', [token]);
      logger.info(`real token ${token}`);
      logger.warn({ authorization: `Bearer ${wrongToken}` });
      logger.error(new Error(`failed with ${token}`));
      logger.debug('64hex', 'a'.repeat(64));
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
    const combined = captured.join('\n');
    assert(captured.length === 4, `expected 4 captured log lines, got ${captured.length}`);
    assert(!combined.includes(token), 'logger printed the real token');
    assert(!combined.includes(wrongToken), 'logger printed the presented token');
    assert(!/[0-9a-f]{64}/i.test(combined), 'logger printed a 64-hex sequence');
    return { lines: captured, redacted: (combined.match(/\[redacted\]/g) ?? []).length };
  });

  /* ---------------- S19: token file location / mode ---------------- */
  await check('S19-token-file', 'hardening', 'Env token is never written to disk; a generated token is written 0600 best-effort inside HALOFLUX_HOME', async () => {
    const envTokenFile = path.join(home, 'token');
    const envTokenWritten = fs.existsSync(envTokenFile);

    // Second bridge WITHOUT HALOFLUX_TOKEN must generate + persist a token file.
    const filePort = await freePort();
    const fileHome = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-p2sec-file-'));
    let fileBridge;
    try {
      fileBridge = await startBridge(filePort, fileHome, null);
      const tokenFile = path.join(fileHome, 'token');
      assert(fs.existsSync(tokenFile), 'generated token file was not created in the isolated home');
      const stored = fs.readFileSync(tokenFile, 'utf8').trim();
      assert(/^[0-9a-f]{64}$/.test(stored), 'token file is not 64 lowercase hex');
      const stat = fs.statSync(tokenFile);
      const health = await rawRequest({ port: filePort, path: '/v1/health' });
      const authed = await rawRequest({ port: filePort, path: '/v1/state', headers: { authorization: `Bearer ${stored}` } });
      assert(health.status === 200, 'second bridge unhealthy');
      assert(authed.status === 200, `token from file was rejected: ${authed.status}`);
      const insideRepo = path.resolve(tokenFile).startsWith(path.resolve(ROOT));
      assert(!insideRepo, 'token file was written inside the repository');
      return {
        envTokenWrittenToDisk: envTokenWritten,
        envTokenNote: 'HALOFLUX_TOKEN is used as-is and never persisted (docs/03 §3).',
        generatedTokenPath: tokenFile,
        generatedTokenBytes: stat.size,
        generatedTokenMode: `0${(stat.mode & 0o777).toString(8)}`,
        generatedTokenAuthenticates: authed.status === 200,
        windowsNote: 'Windows maps chmod to the read-only bit; POSIX 0600 is best-effort (docs/03 §6 PARTIAL).',
        insideRepo,
      };
    } finally {
      if (fileBridge) await fileBridge.stop();
      fs.rmSync(fileHome, { recursive: true, force: true });
    }
  });

  /* ---------------- S20: production port untouched ---------------- */
  await check('S20-production-port', 'network', 'Probe never used the production port 17817', async () => {
    assert(port !== 17817, 'probe used 17817');
    const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const lines = netstat.split(/\r?\n/).filter((line) => line.includes(':17817') && /LISTEN/i.test(line));
    return { probePort: port, productionListenersDuringProbe: lines.length, productionPortLine: lines[0]?.trim() ?? null };
  });

  /* ---------------- S21: bridge alive after all abuse ---------------- */
  await check('S21-bridge-alive', 'resilience', 'Bridge still serves authenticated state after the full abuse sequence', async () => {
    const res = await getJson(port, token, '/v1/state');
    assert(res.status === 200, `final /v1/state expected 200, got ${res.status}`);
    const state = JSON.parse(res.body);
    assert(state && Array.isArray(state.sessions), 'final state malformed');
    assert(bridge.child.exitCode === null, `bridge exited with code ${bridge.child.exitCode}`);
    return {
      status: res.status,
      sessions: state.sessions.length,
      eventCount: state.bridge.eventCount,
      duplicates: state.bridge.duplicates,
      dropped: state.bridge.dropped,
      uptimeMs: state.bridge.uptimeMs,
    };
  });

  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const skipped = checks.filter((c) => c.status === 'SKIP').length;
  evidence.summary = { total: checks.length, pass: passed, fail: failed, skip: skipped };
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log(`\n[probe] ${passed}/${checks.length} PASS, ${failed} FAIL, ${skipped} SKIP`);
  console.log(`[probe] evidence: ${OUT_JSON}`);
  console.log(`[probe] bridge log: ${OUT_LOG}`);

  await bridge.stop();
  fs.rmSync(home, { recursive: true, force: true });

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[probe] harness error:', error && error.stack ? error.stack : error);
  process.exit(2);
});
