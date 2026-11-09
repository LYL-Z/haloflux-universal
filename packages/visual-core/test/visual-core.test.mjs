import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVisualizer,
  PRESETS,
  PRESET_ORDER,
  PRESET_META,
  STATE_META,
  DEFAULT_PRESET,
} from '../src/index.js';
import { createFakeCanvas, createFakeFrames, createFakeDocument, createFakeWindow, sessionView } from './helpers.mjs';

function makeVisualizer(options = {}) {
  const frames = createFakeFrames();
  const canvas = createFakeCanvas(800, 600);
  const viz = createVisualizer({
    canvas,
    document: createFakeDocument(false),
    window: createFakeWindow({ width: 800, height: 600, dpr: 1 }),
    raf: frames.raf,
    caf: frames.caf,
    now: frames.now,
    ...options,
  });
  return { viz, frames, canvas };
}

test('createVisualizer validates its canvas and exposes the §8 API', () => {
  assert.throws(() => createVisualizer({}), /canvas/i);
  const { viz } = makeVisualizer();
  for (const method of [
    'start', 'stop', 'pause', 'resume', 'setSession', 'setSessions',
    'setParams', 'getParams', 'setPreset', 'resize', 'onStats',
    'setStateHook', 'destroy',
  ]) {
    assert.equal(typeof viz[method], 'function', `${method} is part of the contract`);
  }
  viz.destroy();
});

test('initial preset and preset round-trip restore every engine key', () => {
  const { viz } = makeVisualizer({ preset: 'original' });
  assert.equal(viz.getStats().preset, 'original');
  assert.deepEqual(viz.getPresetParams(), { ...PRESETS.original });

  for (const name of PRESET_ORDER) {
    assert.equal(viz.setPreset(name), true);
    assert.equal(viz.getStats().preset, name);
    assert.deepEqual(viz.getPresetParams(), { ...PRESETS[name] });
  }
  // user tweaks must be wiped by a preset switch, otherwise "original" is not original
  viz.setParams({ opacity: 0.1, runnerCount: 50, fpsCap: 24 });
  viz.setPreset('focus');
  viz.setPreset('original');
  assert.deepEqual(viz.getPresetParams(), { ...PRESETS.original });
  assert.equal(viz.getParams().opacity, PRESETS.original.opacity);
  assert.equal(viz.getParams().fpsCap, PRESETS.original.fpsCap);
  viz.setPreset('does-not-exist');
  assert.equal(viz.getStats().preset, 'original', 'invalid preset is ignored');
  viz.destroy();
});

test('default preset follows the frozen settings contract', () => {
  const { viz } = makeVisualizer();
  assert.equal(DEFAULT_PRESET, 'agent-monitor');
  assert.equal(viz.getStats().preset, 'agent-monitor');
  assert.ok(PRESET_META['agent-monitor'].nameZh);
  viz.destroy();
});

test('setSession maps all ten states onto the visual profile', () => {
  const { viz } = makeVisualizer({ preset: 'agent-monitor' });
  for (const state of Object.keys(STATE_META)) {
    viz.setSession(sessionView({ state, reportedState: state, metrics: { toolName: 'Bash' } }));
    const stats = viz.getStats();
    assert.equal(stats.state, state);
    assert.equal(stats.source, 'host-native');
    assert.equal(stats.confidence, 'confirmed');
    assert.equal(stats.simulated, false);
    assert.equal(stats.sessionId, 'claude-code:test-session');
  }
  // no session → disconnected, and it must not pretend to be a host-native session
  viz.setSession(undefined);
  const cleared = viz.getStats();
  assert.equal(cleared.state, 'disconnected');
  assert.equal(cleared.sessionId, '');
  assert.equal(cleared.simulated, false);
  viz.destroy();
});

test('simulated sessions are flagged and metrics stay truthful', () => {
  const { viz } = makeVisualizer({ preset: 'original' });
  viz.setSession(sessionView({ state: 'running', source: 'simulated', confidence: 'unverified', metrics: {} }));
  const stats = viz.getStats();
  assert.equal(stats.simulated, true);
  assert.equal(stats.source, 'simulated');
  assert.equal(stats.confidence, 'unverified');
  viz.setSession(sessionView({ state: 'running', source: 'derived', confidence: 'inferred' }));
  assert.equal(viz.getStats().simulated, false);
  assert.equal(viz.getStats().inferred, true);
  viz.destroy();
});

test('setSessions feeds the multi-agent view without hijacking the primary session', () => {
  const { viz } = makeVisualizer();
  viz.setSession(sessionView({ sessionId: 'primary', state: 'running' }));
  viz.setSessions([
    sessionView({ sessionId: 'a', host: 'codex', state: 'tool' }),
    sessionView({ sessionId: 'b', host: 'cursor', state: 'waiting_approval' }),
    sessionView({ sessionId: 'bad', state: 'nonsense', source: 'nonsense' }),
  ]);
  const stats = viz.getStats();
  assert.equal(stats.sessions, 3);
  assert.equal(viz.getVisualState().sessions.length, 3);
  assert.equal(viz.getStats().sessionId, 'primary');
  // hostile lists are simply ignored
  viz.setSessions(null);
  assert.equal(viz.getStats().sessions, 1);
  viz.destroy();
});

test('setParams clamps, rejects unknown keys and survives garbage', () => {
  const { viz } = makeVisualizer({ preset: 'original' });
  const glowBefore = viz.getParams().glow;
  viz.setParams({ opacity: 42, runnerCount: -5, fpsCap: 999, glow: Number.NaN, hacks: 1 });
  const params = viz.getParams();
  assert.equal(params.opacity, 1);
  assert.equal(params.runnerCount, 0);
  assert.equal(params.fpsCap, 120);
  assert.equal(params.glow, glowBefore, 'invalid values keep the previous effective value');
  assert.equal(params.hacks, undefined);
  viz.setParams(null);
  viz.setParams({});
  assert.equal(viz.getStats().state, 'disconnected');
  viz.destroy();
});

test('stats and state hooks receive HUD-ready payloads', () => {
  const { viz } = makeVisualizer({ preset: 'minimal' });
  const statsEvents = [];
  const stateEvents = [];
  const offStats = viz.onStats((stats) => statsEvents.push(stats));
  const offState = viz.setStateHook((stats) => stateEvents.push(stats));
  assert.equal(statsEvents.length, 1, 'subscriber gets an immediate snapshot');
  assert.equal(stateEvents.length, 1);
  viz.setSession(sessionView({ state: 'tool', source: 'derived', confidence: 'inferred' }));
  const latest = stateEvents[stateEvents.length - 1];
  assert.equal(latest.state, 'tool');
  assert.equal(latest.source, 'derived');
  assert.equal(latest.preset, 'minimal');
  assert.equal(latest.confidence, 'inferred');
  assert.ok('fps' in latest && 'quality' in latest && 'particles' in latest);
  offStats();
  offState();
  viz.setSession(sessionView({ state: 'idle' }));
  const afterUnsubscribe = stateEvents.length;
  viz.setSession(sessionView({ state: 'running' }));
  assert.equal(stateEvents.length, afterUnsubscribe);
  viz.destroy();
});

test('resize accepts explicit size/dpr and reports canvas dimensions', () => {
  const { viz } = makeVisualizer();
  viz.resize({ width: 1280, height: 720, dpr: 2 });
  const stats = viz.getStats();
  assert.equal(stats.cssWidth, 1280);
  assert.equal(stats.cssHeight, 720);
  assert.equal(stats.canvasWidth, 2560);
  assert.equal(stats.canvasHeight, 1440);
  viz.resize({ width: 0, height: 0 });
  viz.destroy();
});

test('start / pause / resume / stop own the rAF loop; destroy leaves nothing pending', () => {
  const { viz, frames } = makeVisualizer();
  assert.equal(viz.start(), true);
  assert.equal(frames.pending(), 1);
  assert.equal(viz.isRunning, true);
  viz.pause();
  assert.equal(frames.pending(), 0);
  viz.resume();
  assert.equal(frames.pending(), 1);
  viz.stop();
  assert.equal(frames.pending(), 0);
  assert.equal(viz.start(), true);
  assert.equal(frames.pending(), 1);
  viz.destroy();
  assert.equal(frames.pending(), 0, 'no rAF callback survives destroy');
  assert.equal(viz.isDestroyed, true);
  assert.equal(viz.start(), false, 'a destroyed visualizer refuses to restart');
  // destroyed methods are inert rather than throwing from a host callback
  viz.setSession(sessionView({ state: 'running' }));
  viz.setPreset('minimal');
  viz.setParams({ opacity: 0.2 });
  assert.equal(viz.getStats().preset, 'agent-monitor');
  viz.destroy();
});

test('reduced motion is surfaced to the HUD and respected by the loop', () => {
  const { viz, frames } = makeVisualizer({ reducedMotion: true });
  assert.equal(viz.getStats().reducedMotion, true);
  viz.start();
  assert.equal(frames.pending(), 1);
  viz.destroy();
});
