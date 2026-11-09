/**
 * Security invariants of the loopback bridge (docs/architecture.md §6, §10).
 *
 * These tests talk raw HTTP so they can control Host/Origin, trickle bodies and
 * observe 413/401 behaviour exactly. The bridge is a real child process with an
 * isolated token/store; the production 17817 port is never used.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeImplemented, startBridge } from '../helpers/bridge.mjs';
import { rawRequest, slowRequest, tcpReachable } from '../helpers/http.mjs';
import { notReady } from '../helpers/env.mjs';
import { event } from '../helpers/events.mjs';

const implemented = bridgeImplemented();
const skipReason = implemented ? false : notReady('packages/event-bridge/src/server.mjs is missing');

describe('bridge security', { skip: skipReason }, () => {
  /** @type {Awaited<ReturnType<typeof startBridge>>} */
  let bridge;
  const collectedBodies = [];

  before(async () => {
    bridge = await startBridge();
  });

  after(async () => {
    await bridge?.stop();
  });

  function authHeaders(extra = {}) {
    return { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', ...extra };
  }

  function freshEvent(overrides = {}) {
    return event('generic', `sess-sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, 'run.start', {
      timestamp: Date.now(),
      ...overrides,
    });
  }

  test('no token → 401 on every authenticated endpoint', async () => {
    for (const [method, pathname, body] of [
      ['GET', '/v1/state', undefined],
      ['GET', '/v1/settings', undefined],
      ['GET', '/v1/stream', undefined],
      ['POST', '/v1/events', JSON.stringify(freshEvent())],
      ['POST', '/v1/simulate', JSON.stringify({ scenario: 'basic' })],
    ]) {
      const res = await rawRequest({ port: bridge.port, method, path: pathname, body, headers: { 'content-type': 'application/json' } });
      collectedBodies.push(res.body);
      assert.equal(res.status, 401, `${method} ${pathname} without token expected 401, got ${res.status}: ${res.body.slice(0, 300)}`);
    }
  });

  test('wrong token → 401 and the presented token is not echoed', async () => {
    const wrong = 'f'.repeat(64);
    for (const pathname of ['/v1/state', '/v1/settings']) {
      const res = await rawRequest({ port: bridge.port, path: pathname, headers: { authorization: `Bearer ${wrong}` } });
      collectedBodies.push(res.body);
      assert.equal(res.status, 401, `GET ${pathname} with wrong token expected 401, got ${res.status}`);
      assert.ok(!res.body.includes(wrong), 'response must not echo the presented token');
      assert.ok(!res.body.includes(bridge.token), 'response must not echo the real token');
    }
    const malformed = await rawRequest({ port: bridge.port, path: '/v1/state', headers: { authorization: 'Bearer' } });
    assert.equal(malformed.status, 401);
  });

  test('alternative X-Haloflux-Token header is accepted', async () => {
    const res = await rawRequest({ port: bridge.port, path: '/v1/state', headers: { 'x-haloflux-token': bridge.token } });
    assert.equal(res.status, 200, `X-Haloflux-Token expected to authenticate, got ${res.status}: ${res.body.slice(0, 300)}`);
  });

  test('SSE with token in query is accepted; wrong query token is 401', async () => {
    const ok = await fetch(`${bridge.base}/v1/stream?token=${encodeURIComponent(bridge.token)}`, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(ok.status, 200);
    await ok.body?.cancel().catch(() => {});
    const bad = await rawRequest({ port: bridge.port, path: '/v1/stream?token=nope' });
    assert.equal(bad.status, 401);
  });

  test('oversized body (>256 KB) → 413', async () => {
    const huge = JSON.stringify({ events: [], padding: 'x'.repeat(300 * 1024) });
    const res = await rawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders({ 'content-length': String(Buffer.byteLength(huge)) }),
      body: huge,
      timeoutMs: 15000,
    });
    collectedBodies.push(res.body);
    assert.equal(res.status, 413, `oversized body expected 413, got ${res.status}: ${res.body.slice(0, 300)}`);
  });

  test('malformed JSON → 400, bridge stays alive', async () => {
    const res = await rawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders(),
      body: '{not json',
    });
    assert.equal(res.status, 400, `malformed JSON expected 400, got ${res.status}: ${res.body.slice(0, 300)}`);
    const health = await rawRequest({ port: bridge.port, path: '/v1/health' });
    assert.equal(health.status, 200);
  });

  test('slow trickling client does not crash the bridge', async () => {
    const input = JSON.stringify(freshEvent());
    const split = Math.floor(input.length / 2);
    const res = await slowRequest({
      port: bridge.port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders(),
      firstChunk: input.slice(0, split),
      secondChunk: input.slice(split),
      delayMs: 450,
      timeoutMs: 10000,
    });
    assert.equal(res.status, 202, `slow but valid request expected 202, got ${res.status}: ${res.body.slice(0, 300)}`);
    const health = await rawRequest({ port: bridge.port, path: '/v1/health' });
    assert.equal(health.status, 200);
  });

  test('slow malformed body → 400 after completion, still alive', async () => {
    const res = await slowRequest({
      port: bridge.port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders(),
      firstChunk: '{"events":[',
      secondChunk: 'oops',
      delayMs: 350,
      timeoutMs: 10000,
    });
    assert.equal(res.status, 400);
    const health = await rawRequest({ port: bridge.port, path: '/v1/health' });
    assert.equal(health.status, 200);
  });

  test('non-loopback Origin is rejected; loopback and null Origin are allowed', async () => {
    const evil = await rawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/v1/events',
      headers: authHeaders({ origin: 'https://evil.example.com' }),
      body: JSON.stringify(freshEvent()),
    });
    assert.ok(
      evil.status >= 400 && evil.status < 500,
      `non-loopback Origin expected 4xx, got ${evil.status}: ${evil.body.slice(0, 300)}`,
    );
    collectedBodies.push(evil.body);
    assert.ok(!evil.body.includes(bridge.token), 'Origin error must not echo the token');

    for (const origin of ['null', 'http://127.0.0.1:57397', 'http://localhost:3000']) {
      const ok = await rawRequest({
        port: bridge.port,
        method: 'POST',
        path: '/v1/events',
        headers: authHeaders({ origin }),
        body: JSON.stringify(freshEvent()),
      });
      assert.equal(ok.status, 202, `Origin ${origin} should be allowed, got ${ok.status}: ${ok.body.slice(0, 300)}`);
    }
  });

  test('non-loopback Host header is rejected', async () => {
    const res = await rawRequest({
      port: bridge.port,
      path: '/v1/state',
      headers: { ...authHeaders(), host: 'evil.example.com' },
    });
    assert.ok(res.status >= 400 && res.status < 500, `non-loopback Host expected 4xx, got ${res.status}`);
  });

  test('path traversal in token query is unauthorized and leaks nothing', async () => {
    const tokenFile = path.join(bridge.home, 'token');
    const fileToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    const homeFiles = fs.readdirSync(bridge.home);
    for (const pathname of [
      '/v1/stream?token=../../token',
      '/v1/stream?token=..%2F..%2Ftoken',
      '/v1/stream?token=%2e%2e%2f%2e%2e%2ftoken',
      '/v1/state?token=../../token',
      '/v1/stream?token=',
    ]) {
      const res = await rawRequest({ port: bridge.port, path: pathname, timeoutMs: 5000 });
      collectedBodies.push(res.body);
      assert.equal(res.status, 401, `${pathname} expected 401, got ${res.status}`);
      if (fileToken) assert.ok(!res.body.includes(fileToken), 'response leaked the token file contents');
      assert.ok(!res.body.includes(bridge.token), 'response leaked the real token');
      for (const file of homeFiles) {
        if (file.length > 3) assert.ok(!res.body.includes(file), `response leaked filename ${file}`);
      }
    }
  });

  test('server binds loopback only (non-internal interface is not reachable)', async (t) => {
    const candidates = [];
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const info of interfaces ?? []) {
        if (info && info.family === 'IPv4' && !info.internal) candidates.push(info.address);
      }
    }
    if (candidates.length === 0) {
      t.skip('no non-loopback IPv4 interface on this machine');
      return;
    }
    for (const address of candidates.slice(0, 3)) {
      const reachable = await tcpReachable(address, bridge.port, 1200);
      assert.equal(reachable, false, `bridge must not listen on ${address}:${bridge.port}`);
    }
  });

  test('no response ever echoes the real token', () => {
    for (const body of collectedBodies) {
      assert.ok(!body.includes(bridge.token), `a response body leaked the token: ${body.slice(0, 300)}`);
    }
  });
});
