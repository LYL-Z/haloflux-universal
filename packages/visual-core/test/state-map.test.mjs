import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_STATES,
  STATE_META,
  SOURCE_META,
  normalizeSession,
  stateVisual,
  toEngineLive,
  isActiveState,
  isIdleLikeState,
  capabilityChips,
  pickPrimarySession,
  sourceBadge,
  confidenceBadge,
  formatMetric,
} from '../src/state-map.js';
import { sessionView } from './helpers.mjs';

test('all ten contract states have colour + ring semantics', () => {
  assert.equal(AGENT_STATES.length, 10);
  for (const state of AGENT_STATES) {
    const meta = STATE_META[state];
    assert.ok(meta, `meta for ${state}`);
    assert.match(meta.color, /^#[0-9a-f]{6}$/i);
    assert.ok(meta.labelZh && meta.labelEn);
    assert.ok(meta.ringZh && meta.ringEn);
  }
  // the mapping contract's active set
  for (const state of ['running', 'tool', 'output', 'waiting_approval', 'error']) {
    assert.equal(isActiveState(state), true);
  }
  for (const state of ['disconnected', 'connected', 'idle', 'done', 'unknown']) {
    assert.equal(isIdleLikeState(state), true);
  }
});

test('SessionView normalisation rejects invalid enums and hostile shapes', () => {
  const normalized = normalizeSession(sessionView({
    state: 'excited',
    reportedState: 'excited',
    source: 'made-up',
    confidence: 'certain',
    metrics: { toolName: 'Bash', step: 3, contextUsed: 'nope', model: 'x'.repeat(300) },
    warnings: ['no-native-output-events', 42],
  }));
  assert.equal(normalized.state, 'unknown');
  assert.equal(normalized.reportedState, 'unknown');
  assert.equal(normalized.source, 'derived');
  assert.equal(normalized.confidence, 'unverified');
  assert.equal(normalized.metrics.toolName, 'Bash');
  assert.equal(normalized.metrics.step, 3);
  assert.equal(normalized.metrics.contextUsed, undefined);
  assert.ok(normalized.metrics.model.length <= 160);
  assert.deepEqual(normalized.warnings, ['no-native-output-events']);
  assert.equal(normalizeSession(null), undefined);
  assert.equal(normalizeSession('x'), undefined);
});

test('stateVisual maps each state to a distinct ring behaviour', () => {
  for (const state of AGENT_STATES) {
    const visual = stateVisual(sessionView({ state, reportedState: state }));
    assert.equal(visual.state, state);
    assert.equal(visual.meta, STATE_META[state]);
    assert.equal(visual.simulated, false);
    assert.equal(visual.confirmed, true);
    // sparse overrides are valid engine params and never contain undefined
    for (const [key, value] of Object.entries(visual.params)) {
      assert.equal(typeof value, 'number', `${state}.${key}`);
    }
  }
  // the contract's marquee behaviours are encoded, not just labelled
  const disconnected = stateVisual(sessionView({ state: 'disconnected' }));
  assert.ok(disconnected.params.idleMotion <= 0.08, 'disconnected is dim');
  assert.equal(disconnected.live.sessionPresent, false);
  assert.equal(disconnected.live.activity, 0);

  const running = stateVisual(sessionView({ state: 'running' }));
  assert.equal(running.live.running, true);
  assert.equal(running.live.activity, 1);

  const waiting = stateVisual(sessionView({ state: 'waiting_approval' }));
  assert.equal(waiting.live.running, true);
  assert.ok(waiting.live.activity < 0.5, 'waiting is not "generating fast"');

  const error = stateVisual(sessionView({ state: 'error', metrics: { toolName: 'Bash' } }));
  assert.equal(error.params.errFx, 1);
  assert.equal(error.params.errPin, 1);
  assert.equal(error.live.tools[0].state, 'error');

  const tool = stateVisual(sessionView({ state: 'tool', metrics: { toolName: 'Bash', step: 2 } }));
  assert.equal(tool.live.tools.length, 1);
  assert.equal(tool.live.tools[0].name, 'Bash');
  assert.equal(tool.live.tools[0].state, 'running');

  const unknown = stateVisual(sessionView({ state: 'unknown' }));
  assert.equal(unknown.params.phaseRing, 1);
});

test('metrics pass through only when the bridge supplied them', () => {
  const empty = stateVisual(sessionView({ metrics: {} }));
  assert.equal(empty.live.tps, 0);
  assert.equal(empty.live.totalTokens, 0);
  assert.equal(empty.live.contextLimit, 0);
  assert.equal(empty.metrics.tokensPerSecond, undefined);
  assert.equal(formatMetric(empty.metrics.tokensPerSecond), '—');

  const real = stateVisual(sessionView({
    state: 'output',
    metrics: {
      tokenCount: 1234,
      tokensPerSecond: 42.5,
      contextUsed: 12000,
      contextLimit: 200000,
      step: 4,
      turn: 2,
      model: 'deepseek-v4',
    },
  }));
  assert.equal(real.live.totalTokens, 1234);
  assert.equal(real.live.tps, 42.5);
  assert.equal(real.live.contextTokens, 12000);
  assert.equal(real.live.contextLimit, 200000);
  assert.equal(real.live.step, 4);
  assert.equal(real.live.turn, 2);
  assert.equal(real.live.model, 'deepseek-v4');
  assert.equal(formatMetric(real.metrics.contextUsed, { percent: true, total: real.metrics.contextLimit }), '6%');
  assert.equal(formatMetric(1234567, { compact: true }), '1.2M');
});

test('source/confidence are never collapsed; simulated is explicit', () => {
  const simulated = stateVisual(sessionView({ source: 'simulated', confidence: 'unverified', state: 'running' }));
  assert.equal(simulated.simulated, true);
  assert.equal(simulated.confirmed, false);
  assert.equal(simulated.inferred, true);
  assert.equal(simulated.live.totalTokens, 0, 'simulated still does not inherit fake host metrics');

  const derived = stateVisual(sessionView({ source: 'derived', confidence: 'inferred' }));
  assert.equal(derived.simulated, false);
  assert.equal(derived.inferred, true);
  assert.equal(sourceBadge('derived').labelZh, '推断');
  assert.equal(sourceBadge('simulated').labelZh, '模拟');
  assert.equal(confidenceBadge('unverified').labelEn, 'unverified');
  assert.deepEqual(Object.keys(SOURCE_META), ['host-native', 'derived', 'simulated']);
});

test('no session produces a truthful disconnected profile, not a fake one', () => {
  const visual = stateVisual(undefined);
  assert.equal(visual.state, 'disconnected');
  assert.equal(visual.sessionId, '');
  assert.equal(visual.live.sessionPresent, false);
  assert.equal(visual.meta, STATE_META.disconnected);
  assert.equal(toEngineLive(undefined).running, false);
});

test('capability chips explain missing data instead of faking it', () => {
  const chips = capabilityChips({ sessionStart: true, toolUse: true, tokenMetrics: false, approval: true, outputStream: false });
  const labels = chips.map((chip) => chip.label);
  assert.ok(labels.includes('无 token 指标'));
  assert.ok(labels.includes('无输出流'));
  assert.ok(labels.includes('支持审批'));
  assert.equal(capabilityChips(null)[0].label, '能力未声明');
});

test('primary session selection prefers urgent, then most recent', () => {
  const error = sessionView({ sessionId: 'e', state: 'error', lastEventAt: 100 });
  const waiting = sessionView({ sessionId: 'w', state: 'waiting_approval', lastEventAt: 900 });
  const running = sessionView({ sessionId: 'r', state: 'running', lastEventAt: 999 });
  const idle = sessionView({ sessionId: 'i', state: 'idle', lastEventAt: 1000 });
  assert.equal(pickPrimarySession([idle, running, waiting, error]).sessionId, 'e');
  assert.equal(pickPrimarySession([idle, running]).sessionId, 'r');
  assert.equal(pickPrimarySession([]), undefined);
  assert.equal(pickPrimarySession(undefined), undefined);
});
