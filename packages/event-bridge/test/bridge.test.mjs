import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  TEST_TOKEN,
  authHeaders,
  createSseReader,
  fetchJson,
  makeEvent,
  rawRequest,
  startBridge,
  uniqueEventId,
} from './helpers.mjs';

const EVENT_ID = uniqueEventId(1);

test('GET /v1/health is public and binds loopback', async () => {
  const ctx = await startBridge();
  try {
    const response = await fetchJson(`${ctx.url}/v1/health`);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.name, 'haloflux-bridge');
    assert.equal(response.body.version, '0.1.0');
    assert.equal(response.body.port, ctx.port);
    assert.ok(ctx.url.startsWith('http://127.0.0.1:'));
  } finally {
    await ctx.close();
  }
});

test('auth: missing token -> 401, wrong token -> 401, body never echoes the token', async () => {
  const ctx = await startBridge();
  try {
    const missing = await fetchJson(`${ctx.url}/v1/state`);
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { error: 'unauthorized' });

    const wrong = await fetchJson(`${ctx.url}/v1/state`, {
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
    });
    assert.equal(wrong.status, 401);
    assert.equal(JSON.stringify(wrong.body).includes(TEST_TOKEN), false);

    const accepted = await fetchJson(`${ctx.url}/v1/state`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.schemaVersion, 1);
  } finally {
    await ctx.close();
  }
});

test('auth: X-Haloflux-Token is accepted; malformed bearer is rejected', async () => {
  const ctx = await startBridge();
  try {
    const header = await fetchJson(`${ctx.url}/v1/state`, { headers: { 'x-haloflux-token': TEST_TOKEN } });
    assert.equal(header.status, 200);

    const malformed = await fetchJson(`${ctx.url}/v1/state`, { headers: { authorization: TEST_TOKEN } });
    assert.equal(malformed.status, 401);
  } finally {
    await ctx.close();
  }
});

test('POST /v1/events accepts a single event and returns 202 {accepted,duplicates,sessions}', async () => {
  const ctx = await startBridge();
  try {
    const event = makeEvent({ eventId: EVENT_ID, sessionId: 'claude-code:one' });
    const posted = await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify(event),
    });
    assert.equal(posted.status, 202);
    assert.equal(posted.body.accepted, 1);
    assert.equal(posted.body.duplicates, 0);
    assert.equal(posted.body.sessions, 1);

    const state = await fetchJson(`${ctx.url}/v1/state`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(state.status, 200);
    assert.equal(state.body.schemaVersion, 1);
    assert.equal(state.body.bridge.eventCount, 1);
    assert.equal(state.body.sessions.length, 1);
    assert.equal(state.body.sessions[0].sessionId, 'claude-code:one');
    assert.equal(state.body.sessions[0].state, 'running');
    assert.equal(state.body.sessions[0].source, 'host-native');
    assert.equal(state.body.activeSessionId, 'claude-code:one');
    assert.equal(state.body.hosts[0].host, 'claude-code');
  } finally {
    await ctx.close();
  }
});

test('duplicate eventIds are counted, not applied', async () => {
  const ctx = await startBridge();
  try {
    const event = makeEvent({ eventId: uniqueEventId(7) });
    const headers = authHeaders(TEST_TOKEN, { 'content-type': 'application/json' });
    const first = await fetchJson(`${ctx.url}/v1/events`, { method: 'POST', headers, body: JSON.stringify(event) });
    assert.equal(first.status, 202);
    assert.equal(first.body.accepted, 1);
    assert.equal(first.body.duplicates, 0);

    const second = await fetchJson(`${ctx.url}/v1/events`, { method: 'POST', headers, body: JSON.stringify(event) });
    assert.equal(second.status, 202);
    assert.equal(second.body.accepted, 0);
    assert.equal(second.body.duplicates, 1);

    const state = await fetchJson(`${ctx.url}/v1/state`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(state.body.bridge.eventCount, 1);
    assert.equal(state.body.bridge.duplicates, 1);
    assert.equal(state.body.sessions[0].recentEvents.length, 1);
  } finally {
    await ctx.close();
  }
});

test('batch of two sessions is accepted and both snapshots appear', async () => {
  const ctx = await startBridge();
  try {
    const events = [
      makeEvent({ eventId: uniqueEventId(11), host: 'codex', sessionId: 'codex:a', eventType: 'tool.start' }),
      makeEvent({ eventId: uniqueEventId(12), host: 'codex', sessionId: 'codex:b', eventType: 'run.end' }),
    ];
    const posted = await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ events }),
    });
    assert.equal(posted.status, 202);
    assert.equal(posted.body.accepted, 2);
    assert.equal(posted.body.sessions, 2);

    const state = await fetchJson(`${ctx.url}/v1/state`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(state.body.sessions.length, 2);
    assert.equal(state.body.hosts.length, 1);
    assert.equal(state.body.hosts[0].host, 'codex');
    assert.equal(state.body.hosts[0].connected, true);

    const stack = await fetchJson(`${ctx.url}/v1/stack`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(stack.status, 200);
    assert.deepEqual(stack.body.sessions, state.body.sessions);
  } finally {
    await ctx.close();
  }
});

test('invalid events -> 400 {issues}; malformed JSON -> 400 invalid_json', async () => {
  const ctx = await startBridge();
  try {
    const headers = authHeaders(TEST_TOKEN, { 'content-type': 'application/json' });
    const invalid = await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ schemaVersion: 1, eventId: 'short' }),
    });
    assert.equal(invalid.status, 400);
    assert.ok(Array.isArray(invalid.body.issues));
    assert.ok(invalid.body.issues.length > 0);
    assert.ok(invalid.body.issues.every((issue) => typeof issue.path === 'string' && typeof issue.code === 'string'));

    const malformed = await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers,
      body: '{ not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.issues[0].code, 'invalid_json');

    const empty = await fetchJson(`${ctx.url}/v1/events`, { method: 'POST', headers, body: '' });
    assert.equal(empty.status, 400);

    const overBatch = { events: Array.from({ length: 101 }, (_, index) => makeEvent({ eventId: uniqueEventId(index) })) };
    const tooMany = await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(overBatch),
    });
    assert.equal(tooMany.status, 400);
    assert.ok(tooMany.body.issues.length > 0);
  } finally {
    await ctx.close();
  }
});

test('oversized event body (>256 KB) -> 413', async () => {
  const ctx = await startBridge();
  try {
    const response = await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: `{"events":[],"padding":"${'x'.repeat(300 * 1024)}"}`,
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.error, 'payload_too_large');
  } finally {
    await ctx.close();
  }
});

test('GET/PUT /v1/settings roundtrip, merge semantics and limits', async () => {
  const ctx = await startBridge();
  try {
    const defaults = await fetchJson(`${ctx.url}/v1/settings`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.schemaVersion, 1);
    assert.equal(defaults.body.preset, 'agent-monitor');
    assert.equal(defaults.body.companion.mode, 'window');

    const put = await fetchJson(`${ctx.url}/v1/settings`, {
      method: 'PUT',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ preset: 'focus', companion: { mode: 'overlay', clickThrough: true } }),
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.preset, 'focus');
    assert.equal(put.body.companion.mode, 'overlay');
    assert.equal(put.body.companion.clickThrough, true);
    assert.equal(put.body.visual.opacity, 0.45);

    const bad = await fetchJson(`${ctx.url}/v1/settings`, {
      method: 'PUT',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ preset: 'not-a-preset' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.issues[0].path, 'preset');

    const tooLarge = await fetchJson(`${ctx.url}/v1/settings`, {
      method: 'PUT',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ preset: 'focus', note: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await ctx.close();
  }
});

test('GET /v1/stream sends snapshot first, then update after a new event', async () => {
  const ctx = await startBridge();
  const controller = new AbortController();
  try {
    const response = await fetch(`${ctx.url}/v1/stream?token=${encodeURIComponent(TEST_TOKEN)}`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = createSseReader(response);

    const snapshot = await reader.nextFrame();
    assert.equal(snapshot.event, 'snapshot');
    assert.equal(snapshot.data.schemaVersion, 1);
    assert.equal(snapshot.data.sessions.length, 0);

    const event = makeEvent({ eventId: uniqueEventId(21), sessionId: 'cursor:sse' });
    await fetchJson(`${ctx.url}/v1/events`, {
      method: 'POST',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify(event),
    });

    const update = await reader.nextFrame();
    assert.equal(update.event, 'update');
    assert.equal(update.data.sessions.length, 1);
    assert.equal(update.data.sessions[0].sessionId, 'cursor:sse');
    reader.cancel();
  } finally {
    controller.abort();
    await ctx.close();
  }
});

test('SSE with a wrong token is rejected', async () => {
  const ctx = await startBridge();
  try {
    const response = await fetch(`${ctx.url}/v1/stream?token=${'c'.repeat(64)}`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.deepEqual(body, { error: 'unauthorized' });
  } finally {
    await ctx.close();
  }
});

test('per-connection rate limit returns 429 after the configured burst', async () => {
  const ctx = await startBridge({ rateLimitPerSecond: 3, rateLimitWindowMs: 10000 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await rawRequest(`${ctx.url}/v1/health`, { agent });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.ok(statuses.slice(3).every((status) => status === 429), `unexpected statuses: ${statuses.join(',')}`);
  } finally {
    agent.destroy();
    await ctx.close();
  }
});

test('Origin: non-loopback rejected; file:// and null allowed with CORS headers', async () => {
  const ctx = await startBridge();
  try {
    const evil = await fetchJson(`${ctx.url}/v1/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.deepEqual(evil.body, { error: 'forbidden_origin' });

    const fileOrigin = await rawRequest(`${ctx.url}/v1/health`, { headers: { origin: 'file://' } });
    assert.equal(fileOrigin.status, 200);
    assert.equal(fileOrigin.headers['access-control-allow-origin'], 'file://');

    const nullOrigin = await rawRequest(`${ctx.url}/v1/health`, { headers: { origin: 'null' } });
    assert.equal(nullOrigin.status, 200);
    assert.equal(nullOrigin.headers['access-control-allow-origin'], 'null');

    const loopback = await rawRequest(`${ctx.url}/v1/health`, { headers: { origin: 'http://127.0.0.1:5173' } });
    assert.equal(loopback.status, 200);
    assert.equal(loopback.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
  } finally {
    await ctx.close();
  }
});

test('Host header must be 127.0.0.1 or localhost', async () => {
  const ctx = await startBridge();
  try {
    const badHost = await rawRequest(`${ctx.url}/v1/health`, { headers: { Host: 'evil.example' } });
    assert.equal(badHost.status, 403);
    assert.deepEqual(JSON.parse(badHost.text), { error: 'forbidden_host' });
  } finally {
    await ctx.close();
  }
});

test('OPTIONS preflight is answered without auth and with CORS', async () => {
  const ctx = await startBridge();
  try {
    const preflight = await rawRequest(`${ctx.url}/v1/events`, {
      method: 'OPTIONS',
      headers: {
        origin: 'file://',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'file://');
    assert.match(preflight.headers['access-control-allow-methods'] || '', /POST/);
    assert.match(preflight.headers['access-control-allow-headers'] || '', /authorization/i);
  } finally {
    await ctx.close();
  }
});

test('POST /v1/simulate pushes the full simulated sequence', async () => {
  const ctx = await startBridge();
  try {
    const simulate = await fetchJson(`${ctx.url}/v1/simulate`, {
      method: 'POST',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ scenario: 'demo', intervalMs: 0 }),
    });
    assert.equal(simulate.status, 202);
    assert.equal(simulate.body.scenario, 'demo');
    assert.equal(simulate.body.source, 'simulated');
    assert.equal(simulate.body.scheduled, 19);

    const state = await fetchJson(`${ctx.url}/v1/state`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(state.status, 200);
    assert.equal(state.body.sessions.length, 1);
    const session = state.body.sessions[0];
    assert.equal(session.host, 'simulator');
    assert.equal(session.source, 'simulated');
    assert.equal(session.state, 'disconnected');
    const eventTypes = session.recentEvents.map((entry) => entry.eventType);
    for (const required of ['tool.start', 'tool.fail', 'approval.request', 'run.end']) {
      assert.ok(eventTypes.includes(required), `missing ${required}`);
    }

    const badScenario = await fetchJson(`${ctx.url}/v1/simulate`, {
      method: 'POST',
      headers: authHeaders(TEST_TOKEN, { 'content-type': 'application/json' }),
      body: JSON.stringify({ scenario: 'nope' }),
    });
    assert.equal(badScenario.status, 400);
    assert.equal(badScenario.body.issues[0].code, 'unknown_scenario');
  } finally {
    await ctx.close();
  }
});

test('unknown route -> 404, wrong method -> 405', async () => {
  const ctx = await startBridge();
  try {
    const missing = await fetchJson(`${ctx.url}/v1/nope`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(missing.status, 404);
    const wrongMethod = await fetchJson(`${ctx.url}/v1/events`, { headers: authHeaders(TEST_TOKEN) });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await ctx.close();
  }
});
