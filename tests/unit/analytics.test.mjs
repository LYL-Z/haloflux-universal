import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventRate, percentiles, toolWaterfall, criticalPath, jainIndex, littleLaw,
  shannonEntropy, jsDivergence, stateTransitions, contextUsage, METRIC_REGISTRY,
} from '../../packages/analytics/src/index.mjs';

const base = { sessionId: 's1', runId: 'r1', source: 'host-native', confidence: 'confirmed' };

test('event rate uses the explicit window and exposes cache coverage', () => {
  const now = 100_000;
  const result = eventRate([
    { ...base, timestamp: now - 1_000 },
    { ...base, timestamp: now - 9_000 },
    { ...base, timestamp: now - 30_000 }, // outside 10 s window
  ], { now, windowMs: 10_000, buckets: 5, cacheLimit: 30 });
  assert.equal(result.count, 2);
  assert.equal(result.lambdaPerSecond, 0.2);
  assert.equal(result.buckets.reduce((a, b) => a + b, 0), 2);
  assert.equal(result.cacheTruncated, false);
});

test('tool waterfall pairs by session+run+call and marks the rest UNCORRELATED', () => {
  const result = toolWaterfall([
    { ...base, eventType: 'tool.start', toolCallId: 'c1', timestamp: 1000, toolName: 'Bash' },
    { ...base, eventType: 'tool.end', toolCallId: 'c1', timestamp: 1600 },
    { ...base, sessionId: 's2', eventType: 'tool.end', toolCallId: 'c2', timestamp: 2000 },
    { ...base, eventType: 'tool.start', toolCallId: 'c3', timestamp: 3000 },
    { ...base, runId: 'r2', eventType: 'tool.end', toolCallId: 'c3', timestamp: 3400 },
  ]);
  assert.equal(result.completed, 1);
  assert.equal(result.uncorrelated, 2);
  assert.equal(result.rows.find((row) => row.toolCallId === 'c1').durationMs, 600);
  assert.equal(result.rows.find((row) => row.toolCallId === 'c3').correlated, false);
});

test('critical path follows dependencies and refuses cycles', () => {
  const result = criticalPath([
    { id: 'a', durationMs: 100 },
    { id: 'b', durationMs: 200, dependsOn: ['a'] },
    { id: 'c', durationMs: 50, dependsOn: ['b'] },
    { id: 'd', durationMs: 400 },
  ]);
  assert.equal(result.durationMs, 400);
  assert.deepEqual(result.path, ['d']);
  const chain = criticalPath([
    { id: 'a', durationMs: 100 },
    { id: 'b', durationMs: 200, dependsOn: ['a'] },
    { id: 'c', durationMs: 50, dependsOn: ['b'] },
  ]);
  assert.equal(chain.durationMs, 350);
  assert.deepEqual(chain.path, ['a', 'b', 'c']);
  const cycle = criticalPath([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] },
  ]);
  assert.equal(cycle.durationMs, null);
  assert.match(cycle.error, /cycle/);
});

test('fairness, little law and entropy expose their preconditions', () => {
  assert.equal(jainIndex([5, 5, 5]).value, 1);
  assert.equal(jainIndex([5, 0, 0]).value, 0.3333333333333333);
  assert.equal(littleLaw({ arrivalRatePerSecond: 2, waitMs: 500, samples: 5 }).queueLength, null);
  assert.equal(littleLaw({ arrivalRatePerSecond: 2, waitMs: 500, samples: 40 }).queueLength, 1);
  assert.equal(shannonEntropy([0.5, 0.5]).bits, 1);
  assert.equal(shannonEntropy([]).bits, null);
  assert.equal(jsDivergence([0.5, 0.5], [0.5, 0.5]).bits, 0);
});

test('percentiles and state transitions stay sample-aware', () => {
  const p = percentiles([1, 2, 3, 4, 100]);
  assert.equal(p.n, 5);
  assert.equal(p.p50, 3);
  assert.ok(Math.abs(p.p95 - 80.8) < 1e-9);
  const transitions = stateTransitions([
    { state: 'running' }, { state: 'tool' }, { state: 'tool' }, { state: 'done' },
  ]);
  assert.equal(transitions.samples, 3);
  assert.equal(transitions.matrix.running.tool.probability, 1);
  assert.equal(transitions.matrix.tool.tool.probability, 0.5);
  assert.equal(contextUsage(1000, 8000).ratio, 0.125);
  assert.equal(contextUsage(null, 8000).ratio, null);
});

test('registry declares formula, inputs and limitation for every metric', () => {
  for (const [key, meta] of Object.entries(METRIC_REGISTRY)) {
    assert.ok(meta.formula, key);
    assert.ok(meta.inputs, key);
    assert.ok(meta.limitation, key);
    assert.ok(meta.evidence, key);
  }
});
