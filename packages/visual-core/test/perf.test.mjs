import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPerfGovernor,
  clampDpr,
  qualityFactor,
  QUALITY_FACTORS,
  PERF_DEFAULTS,
} from '../src/perf.js';
import { createFakeFrames, createFakeDocument } from './helpers.mjs';

function makeHarness(overrides = {}) {
  const frames = createFakeFrames();
  const doc = createFakeDocument(false);
  const calls = [];
  const stats = [];
  const qualities = [];
  const governor = createPerfGovernor({
    onFrame: (dt, meta) => calls.push({ dt, meta }),
    onStats: (value) => stats.push(value),
    onQuality: (level, factor) => qualities.push({ level, factor }),
    getParticles: () => 42,
    document: doc,
    now: frames.now,
    raf: frames.raf,
    caf: frames.caf,
    statsIntervalMs: 200,
    lowWindowMs: 200,
    recoveryWindowMs: 200,
    cooldownMs: 0,
    targetFps: 60,
    idleFps: 24,
    ...overrides,
  });
  return { frames, doc, calls, stats, qualities, governor };
}

test('quality factors are the contract steps (1 → 0.75 → 0.5)', () => {
  assert.deepEqual([...QUALITY_FACTORS], [1, 0.75, 0.5]);
  assert.equal(qualityFactor(0), 1);
  assert.equal(qualityFactor(1), 0.75);
  assert.equal(qualityFactor(2), 0.5);
  assert.equal(qualityFactor(99), 0.5);
});

test('dpr is clamped to a safe [1,3] range', () => {
  assert.equal(clampDpr(0.5), 1);
  assert.equal(clampDpr(2), 2);
  assert.equal(clampDpr(3.5), 3);
  assert.equal(clampDpr('nope'), 1);
  assert.equal(clampDpr(undefined), 1);
});

test('start schedules frames and stop cancels the rAF handle', () => {
  const { frames, calls, governor } = makeHarness();
  assert.equal(governor.start(), true);
  assert.equal(frames.pending(), 1);
  for (let i = 0; i < 10; i += 1) frames.step(16);
  assert.ok(calls.length >= 9, `expected frames, got ${calls.length}`);
  governor.stop();
  assert.equal(frames.pending(), 0);
  assert.equal(governor.isRunning(), false);
});

test('paused governor schedules no drawing, resume restarts it', () => {
  const { frames, calls, governor } = makeHarness();
  governor.start();
  frames.step(16);
  const before = calls.length;
  governor.pause();
  for (let i = 0; i < 10; i += 1) frames.step(16);
  assert.equal(calls.length, before);
  assert.equal(frames.pending(), 0);
  governor.resume();
  assert.equal(frames.pending(), 1);
  frames.step(16);
  assert.ok(calls.length > before);
  governor.destroy();
});

test('idle sessions use the idle frame cap', () => {
  let idle = false;
  const fast = makeHarness({ isIdle: () => idle });
  fast.governor.start();
  for (let i = 0; i < 60; i += 1) fast.frames.step(16);
  const fastFrames = fast.calls.length;
  fast.governor.destroy();

  idle = true;
  const slow = makeHarness({ isIdle: () => idle });
  slow.governor.start();
  for (let i = 0; i < 60; i += 1) slow.frames.step(16);
  assert.ok(slow.calls.length < fastFrames,
    `idle cap should draw fewer frames (${slow.calls.length} vs ${fastFrames})`);
  slow.governor.destroy();
});

test('sustained low fps degrades quality ×0.75 then ×0.5 and recovers', () => {
  const { frames, qualities, governor } = makeHarness();
  governor.start();
  // ~30fps rAF cadence for long enough to trip two quality steps
  for (let i = 0; i < 30; i += 1) frames.step(33);
  assert.equal(governor.getQualityLevel(), 2);
  assert.equal(governor.getQualityFactor(), 0.5);
  assert.deepEqual(qualities.map((entry) => entry.level), [1, 2]);

  // back to 60fps: recovery needs the eased raw-fps estimate to clear 55
  for (let i = 0; i < 120; i += 1) frames.step(16);
  assert.equal(governor.getQualityLevel(), 0, 'returns to the top quality step');
  assert.equal(governor.getQualityFactor(), 1);
  governor.destroy();
});

test('visibilitychange pauses the loop and resumes when visible', () => {
  const { frames, doc, calls, governor } = makeHarness();
  governor.start();
  frames.step(16);
  const before = calls.length;
  doc.hidden = true;
  doc.dispatch('visibilitychange');
  assert.equal(frames.pending(), 0);
  for (let i = 0; i < 5; i += 1) {
    frames.step(16);
    assert.equal(calls.length, before);
  }
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  assert.equal(frames.pending(), 1);
  frames.step(16);
  assert.ok(calls.length > before);
  governor.destroy();
  assert.equal(doc.listenerCount('visibilitychange'), 0);
});

test('stats expose fps, frameMs, quality, particles and paused state', () => {
  const { frames, stats, governor } = makeHarness();
  governor.start();
  for (let i = 0; i < 20; i += 1) frames.step(16);
  assert.ok(stats.length >= 1);
  const latest = stats[stats.length - 1];
  assert.ok(Number.isFinite(latest.fps));
  assert.ok(latest.fps > 0);
  assert.ok(Number.isFinite(latest.frameMs));
  assert.equal(latest.particles, 42);
  assert.equal(latest.quality, 1);
  assert.equal(latest.qualityLevel, 0);
  assert.equal(latest.running, true);
  const snapshot = governor.getStats();
  assert.equal(snapshot.particles, 42);
  assert.equal(snapshot.effectiveFps, 60, 'active sessions use the target cap');
  const idleGovernor = makeHarness({ isIdle: () => true }).governor;
  assert.equal(idleGovernor.getStats().effectiveFps, 24, 'idle sessions use the idle cap');
  idleGovernor.destroy();
  governor.destroy();
});

test('destroy leaves no rAF callback and cancels a pending frame', () => {
  const { frames, governor, doc } = makeHarness();
  governor.start();
  assert.equal(frames.pending(), 1);
  governor.destroy();
  assert.equal(frames.pending(), 0);
  assert.equal(governor.isDestroyed(), true);
  assert.equal(governor.start(), false);
  // ticking an empty queue must be a no-op, not an exception
  assert.equal(frames.step(16), false);
  assert.equal(doc.listenerCount('visibilitychange'), 0);
});

test('a throwing frame renderer does not kill the governor', () => {
  let calls = 0;
  const frames = createFakeFrames();
  const governor = createPerfGovernor({
    onFrame: () => { calls += 1; throw new Error('renderer bug'); },
    document: createFakeDocument(false),
    now: frames.now,
    raf: frames.raf,
    caf: frames.caf,
    statsIntervalMs: 10_000,
  });
  governor.start();
  frames.step(16);
  frames.step(16);
  assert.equal(calls, 2);
  assert.equal(frames.pending(), 1);
  governor.destroy();
});

test('defaults match the contract (60fps / idle 24fps / low 42 / recover 55)', () => {
  assert.equal(PERF_DEFAULTS.targetFps, 60);
  assert.equal(PERF_DEFAULTS.idleFps, 24);
  assert.equal(PERF_DEFAULTS.lowFps, 42);
  assert.equal(PERF_DEFAULTS.recoverFps, 55);
  assert.equal(PERF_DEFAULTS.lowWindowMs, 1200);
});
