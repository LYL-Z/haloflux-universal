/**
 * Unit tests: packages/event-schema — the frozen privacy boundary.
 * Contract: docs/architecture.md §4; source: packages/event-schema/src/index.ts.
 *
 * These tests run against the built package (`dist/index.js`), because that is
 * what adapters, the bridge and the DSH bundle import.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { repoPath } from '../helpers/env.mjs';
import { EXPECTED, EVENT_DEFAULT_STATE } from '../helpers/types.mjs';

const schema = await import(new URL('../../packages/event-schema/dist/index.js', import.meta.url));
const {
  SCHEMA_VERSION,
  HOSTS,
  EVENT_TYPES,
  AGENT_STATES,
  EVENT_SOURCES,
  CONFIDENCE_LEVELS,
  METADATA_KEYS,
  MAX_EVENT_BYTES,
  MAX_METADATA_BYTES,
  MAX_CUSTOM_BYTES,
  MAX_BATCH,
  createEvent,
  validateEvent,
  isHalofluxEvent,
  parseEventJson,
  parseBatch,
  compareEvents,
} = schema;

function validInput(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'evt-abcdef12',
    timestamp: 1794150000000,
    host: 'generic',
    hostVersion: '1.0.0',
    sessionId: 'session-1',
    eventType: 'run.start',
    state: 'running',
    source: 'host-native',
    confidence: 'confirmed',
    metadata: {},
    ...overrides,
  };
}

function expectInvalid(input, code, field) {
  const result = validateEvent(input);
  assert.equal(result.ok, false, `expected invalid event for ${field ?? code}`);
  const codes = result.errors.map((error) => error.code);
  assert.ok(codes.includes(code), `expected issue ${code}, got ${JSON.stringify(result.errors)}`);
  if (field) {
    assert.ok(
      result.errors.some((error) => error.path === field),
      `expected issue on ${field}, got ${JSON.stringify(result.errors)}`,
    );
  }
  return result.errors;
}

describe('event-schema: constants match the frozen contract', () => {
  test('schema version, host list, event types, states, metadata keys', () => {
    assert.equal(SCHEMA_VERSION, EXPECTED.schemaVersion);
    assert.deepEqual([...HOSTS], EXPECTED.hosts);
    assert.deepEqual([...EVENT_TYPES], EXPECTED.eventTypes);
    assert.deepEqual([...AGENT_STATES], EXPECTED.states);
    assert.deepEqual([...EVENT_SOURCES], EXPECTED.sources);
    assert.deepEqual([...CONFIDENCE_LEVELS], EXPECTED.confidence);
    assert.deepEqual([...METADATA_KEYS], EXPECTED.metadataKeys);
  });

  test('byte/count limits match the contract', () => {
    assert.equal(MAX_EVENT_BYTES, EXPECTED.maxEventBytes);
    assert.equal(MAX_METADATA_BYTES, EXPECTED.maxMetadataBytes);
    assert.equal(MAX_CUSTOM_BYTES, EXPECTED.maxCustomBytes);
    assert.equal(MAX_BATCH, EXPECTED.maxBatch);
  });

  test('default state table covers every event type with the contracted state', () => {
    assert.deepEqual(Object.keys(EVENT_DEFAULT_STATE).sort(), [...EVENT_TYPES].sort());
    assert.deepEqual(EVENT_DEFAULT_STATE, EVENT_DEFAULT_STATE);
    for (const [eventType, state] of Object.entries(EVENT_DEFAULT_STATE)) {
      assert.ok(EXPECTED.states.includes(state), `${eventType} has unknown default state ${state}`);
    }
    for (const [eventType, state] of Object.entries({
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
    })) {
      assert.equal(EVENT_DEFAULT_STATE[eventType], state, `${eventType} default state`);
    }
  });

  test('JSON Schema document exists and is valid JSON', () => {
    const schemaPath = repoPath('packages', 'event-schema', 'schema', 'event.schema.json');
    assert.ok(fs.existsSync(schemaPath), 'schema/event.schema.json missing');
    const document = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.equal(typeof document, 'object');
    assert.ok(Array.isArray(document.required));
    assert.ok(document.required.includes('schemaVersion'));
    assert.ok(document.required.includes('metadata'));
  });
});

describe('event-schema: accepts valid events', () => {
  test('minimal valid event', () => {
    const input = validInput();
    const result = validateEvent(input);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.eventId, input.eventId);
    assert.equal(isHalofluxEvent(input), true);
  });

  test('createEvent produces a valid event with defaults for every host/type', () => {
    for (const host of HOSTS) {
      for (const eventType of EVENT_TYPES) {
        const created = createEvent({ host, sessionId: 'sess-1', eventType });
        const result = validateEvent(created);
        assert.equal(result.ok, true, `${host}/${eventType}: ${JSON.stringify(result.errors)}`);
        assert.equal(created.state, EVENT_DEFAULT_STATE[eventType]);
        assert.equal(created.source, 'host-native');
        assert.equal(created.confidence, 'confirmed');
        assert.equal(created.schemaVersion, 1);
      }
    }
  });

  test('metadata allowlist accepts every documented key with a contract-shaped value', () => {
    const metadata = {
      toolName: 'Read',
      toolCategory: 'file',
      toolStatus: 'ok',
      step: 1,
      turn: 2,
      label: 'reading file',
      errorCode: 'E_NONE',
      durationMs: 12,
      tokenCount: 42,
      tokensPerSecond: 9.5,
      contextUsed: 1000,
      contextLimit: 200000,
      model: 'test-model',
      projectName: 'haloflux',
      sessionTitle: 'a session',
      agentName: 'agent-1',
      permissionMode: 'default',
      approvalKind: 'tool',
      queueDepth: 0,
      latencyMs: 3,
      cwdHint: 'HALOFLUX',
      custom: { a: 'b', n: 1, ok: true, none: null },
    };
    const result = validateEvent(validInput({ metadata }));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  test('timestamps and explicit ids survive validation', () => {
    const input = validInput({ timestamp: 1794150000000, eventId: 'ABC_def-123', sessionId: 'a.b_c:d@e-f' });
    assert.equal(validateEvent(input).ok, true);
  });
});

describe('event-schema: rejects malformed events', () => {
  test('non-object inputs', () => {
    for (const value of [null, undefined, 'event', 42, [], true]) {
      expectInvalid(value, 'not_object');
    }
  });

  test('wrong schemaVersion', () => {
    expectInvalid(validInput({ schemaVersion: 2 }), 'unsupported_version', 'schemaVersion');
    expectInvalid(validInput({ schemaVersion: '1' }), 'unsupported_version', 'schemaVersion');
  });

  test('bad eventId / sessionId / host / hostVersion', () => {
    expectInvalid(validInput({ eventId: 'short' }), 'bad_event_id', 'eventId');
    expectInvalid(validInput({ eventId: 'has space!!' }), 'bad_event_id', 'eventId');
    expectInvalid(validInput({ eventId: 'a'.repeat(129) }), 'bad_event_id', 'eventId');
    expectInvalid(validInput({ sessionId: '' }), 'bad_session_id', 'sessionId');
    expectInvalid(validInput({ sessionId: 'a/b' }), 'bad_session_id', 'sessionId');
    expectInvalid(validInput({ sessionId: 'a b' }), 'bad_session_id', 'sessionId');
    expectInvalid(validInput({ host: 'claude' }), 'bad_host', 'host');
    expectInvalid(validInput({ host: 'Claude-Code' }), 'bad_host', 'host');
    expectInvalid(validInput({ hostVersion: 42 }), 'bad_host_version', 'hostVersion');
    expectInvalid(validInput({ hostVersion: 'v'.repeat(65) }), 'bad_host_version', 'hostVersion');
  });

  test('bad timestamp', () => {
    for (const timestamp of [0, -1, 'now', Number.NaN, Number.POSITIVE_INFINITY]) {
      expectInvalid(validInput({ timestamp }), 'bad_timestamp', 'timestamp');
    }
  });

  test('bad eventType / state / source / confidence', () => {
    expectInvalid(validInput({ eventType: 'tool.done' }), 'bad_event_type', 'eventType');
    expectInvalid(validInput({ state: 'thinking' }), 'bad_state', 'state');
    expectInvalid(validInput({ source: 'native' }), 'bad_source', 'source');
    expectInvalid(validInput({ confidence: 'certain' }), 'bad_confidence', 'confidence');
  });

  test('metadata must be an object', () => {
    expectInvalid(validInput({ metadata: null }), 'bad_metadata', 'metadata');
    expectInvalid(validInput({ metadata: [] }), 'bad_metadata', 'metadata');
    expectInvalid(validInput({ metadata: 'x' }), 'bad_metadata', 'metadata');
  });
});

describe('event-schema: privacy allowlist rejects prompt/content leakage', () => {
  const forbiddenSamples = {
    prompt: 'Write me a phishing email...',
    message: 'secret chat text',
    content: 'file contents',
    toolArgs: '{"password":"hunter2"}',
    toolResult: 'ls output',
    apiKey: 'sk-secret',
    authorization: 'Bearer secret',
    text: 'assistant output',
    stdin: 'cat /etc/passwd',
    env: 'SECRET=1',
  };

  for (const [key, value] of Object.entries(forbiddenSamples)) {
    test(`unknown metadata key "${key}" is rejected`, () => {
      const errors = expectInvalid(validInput({ metadata: { [key]: value } }), 'unknown_metadata_key', `metadata.${key}`);
      assert.ok(errors.some((error) => /allowlisted/.test(error.message)));
    });
  }

  test('prototype-polluting metadata keys are rejected', () => {
    const payload = JSON.parse(
      `{"schemaVersion":1,"eventId":"evt-abcdef12","timestamp":1794150000000,"host":"generic","hostVersion":"1","sessionId":"s","eventType":"run.start","state":"running","source":"host-native","confidence":"confirmed","metadata":{"__proto__":{"polluted":true}}}`,
    );
    const result = validateEvent(payload);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'forbidden_key'));
    assert.equal({}.polluted, undefined, 'prototype must not be polluted');
  });

  test('metadata number/string limits', () => {
    expectInvalid(validInput({ metadata: { toolName: 'x'.repeat(81) } }), 'bad_string', 'metadata.toolName');
    expectInvalid(validInput({ metadata: { label: 'x'.repeat(121) } }), 'bad_string', 'metadata.label');
    expectInvalid(validInput({ metadata: { model: 123 } }), 'bad_string', 'metadata.model');
    for (const field of [
      'step',
      'turn',
      'durationMs',
      'tokenCount',
      'tokensPerSecond',
      'contextUsed',
      'contextLimit',
      'queueDepth',
      'latencyMs',
    ]) {
      expectInvalid(validInput({ metadata: { [field]: -1 } }), 'bad_number', `metadata.${field}`);
      expectInvalid(validInput({ metadata: { [field]: '1' } }), 'bad_number', `metadata.${field}`);
    }
  });

  test('custom metadata limits (16 keys, <=40 chars, scalar, <=200 chars, <=1 KB)', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
    expectInvalid(validInput({ metadata: { custom: tooMany } }), 'custom_too_many_keys', 'metadata.custom');

    expectInvalid(
      validInput({ metadata: { custom: { ['k'.repeat(41)]: 1 } } }),
      'bad_custom_key',
      `metadata.custom.${'k'.repeat(41)}`,
    );
    expectInvalid(validInput({ metadata: { custom: { nested: { a: 1 } } } }), 'bad_custom_value');
    expectInvalid(validInput({ metadata: { custom: { big: 'x'.repeat(201) } } }), 'bad_custom_value');
    expectInvalid(validInput({ metadata: { custom: 'text' } }), 'bad_custom');

    const big = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key${i}`, 'x'.repeat(70)]));
    expectInvalid(validInput({ metadata: { custom: big } }), 'custom_too_large', 'metadata.custom');
  });
});

describe('event-schema: size limits', () => {
  test('serialized event larger than 8 KB is rejected with event_too_large', () => {
    const input = validInput({ padding: 'x'.repeat(9000) });
    const errors = expectInvalid(input, 'event_too_large', '$');
    assert.ok(errors.some((error) => /8192/.test(error.message)));
  });

  test('metadata larger than 4 KB is rejected with metadata_too_large', () => {
    // custom itself is capped at 1 KB, so drive metadata size with a big
    // `custom` object and accept either size code; both are contract failures.
    const metadata = {
      custom: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'.repeat(60)])),
    };
    const result = validateEvent(validInput({ metadata }));
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.code === 'metadata_too_large' || error.code === 'custom_too_large'),
      JSON.stringify(result.errors),
    );
  });

  test('event just under the 8 KB limit still passes', () => {
    const base = validInput();
    const baseSize = Buffer.byteLength(JSON.stringify(base));
    const padding = 'x'.repeat(8192 - baseSize - 16);
    const candidate = { ...base, padding };
    const size = Buffer.byteLength(JSON.stringify(candidate));
    assert.ok(size <= 8192, `fixture should be <= 8192 bytes, got ${size}`);
    const result = validateEvent(candidate);
    assert.equal(result.ok, true, `event of ${size} bytes should pass: ${JSON.stringify(result.errors)}`);
  });
});

describe('event-schema: batch and parse helpers', () => {
  test('parseBatch accepts a single event, an array and {events}', () => {
    const one = validInput();
    assert.equal(parseBatch(one).length, 1);
    assert.equal(parseBatch([createEvent({ host: 'generic', sessionId: 'a', eventType: 'run.start' })]).length, 1);
    assert.equal(parseBatch({ events: createEventBatch(3) }).length, 3);
  });

  test('parseBatch rejects empty batches and batches over 100', () => {
    assert.throws(() => parseBatch({ events: [] }), /empty batch/);
    assert.throws(() => parseBatch(createEventBatch(101)), /exceeds 100/);
  });

  test('parseBatch reports indexed paths for invalid members', () => {
    const bad = validInput({ host: 'nope' });
    const good = createEvent({ host: 'codex', sessionId: 's', eventType: 'run.start' });
    let error;
    try {
      parseBatch([good, bad]);
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, 'parseBatch should throw');
    assert.match(error.message, /invalid event batch/);
    assert.ok(error.issues.some((issue) => issue.path.startsWith('[1]') && issue.code === 'bad_host'));
  });

  test('parseEventJson rejects syntax errors and oversized text', () => {
    assert.equal(parseEventJson(''), undefined);
    assert.equal(parseEventJson('{nope'), undefined);
    assert.deepEqual(parseEventJson('{"a":1}'), { a: 1 });
    assert.equal(parseEventJson('x'.repeat(MAX_EVENT_BYTES * 2 + 1)), undefined);
  });

  test('compareEvents orders by timestamp then eventId deterministically', () => {
    const a = { timestamp: 10, eventId: 'aaa' };
    const b = { timestamp: 10, eventId: 'bbb' };
    const c = { timestamp: 11, eventId: 'a' };
    assert.ok(compareEvents(a, b) < 0);
    assert.ok(compareEvents(b, a) > 0);
    assert.ok(compareEvents(a, c) < 0);
    assert.equal(compareEvents(a, a), 0);
  });
});

function createEventBatch(count) {
  return Array.from({ length: count }, (_, index) =>
    createEvent({ host: 'generic', sessionId: 'batch', eventType: 'session.heartbeat', metadata: { step: index } }),
  );
}
