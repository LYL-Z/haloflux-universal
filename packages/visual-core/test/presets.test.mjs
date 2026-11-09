import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  PRESET_ORDER,
  PRESET_META,
  DEFAULT_PRESET,
  PARAM_MAP,
  ENGINE_PARAM_KEYS,
  clampParamValue,
  clampVisualParam,
  sanitizeParams,
  engineParamsOnly,
  getPreset,
  resolvePreset,
  isPresetName,
  QUALITY_SCALED_KEYS,
} from '../src/presets.js';

test('exactly six presets with bilingual metadata', () => {
  assert.deepEqual(PRESET_ORDER, ['original', 'minimal', 'sci-fi', 'focus', 'ambient', 'agent-monitor']);
  for (const name of PRESET_ORDER) {
    const meta = PRESET_META[name];
    assert.ok(meta, `metadata for ${name}`);
    assert.ok(meta.nameZh.length > 0, `${name} zh name`);
    assert.ok(meta.nameEn.length > 0, `${name} en name`);
    assert.ok(meta.descriptionZh.length > 10, `${name} zh description`);
    assert.ok(meta.descriptionEn.length > 10, `${name} en description`);
  }
  assert.equal(DEFAULT_PRESET, 'agent-monitor');
});

test('every preset is a complete, in-range parameter set', () => {
  for (const name of PRESET_ORDER) {
    const preset = PRESETS[name];
    assert.equal(Object.keys(preset).length, ENGINE_PARAM_KEYS.length + 1, `${name} key count`);
    for (const key of ENGINE_PARAM_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(preset, key), `${name} is missing ${key}`);
      const meta = PARAM_MAP[key];
      const value = preset[key];
      assert.ok(Number.isFinite(value), `${name}.${key} must be numeric`);
      assert.ok(value >= meta.min - 1e-9 && value <= meta.max + 1e-9,
        `${name}.${key}=${value} outside [${meta.min}, ${meta.max}]`);
    }
    assert.ok(Number.isFinite(preset.fpsCap));
    assert.ok(preset.fpsCap >= 24 && preset.fpsCap <= 120);
  }
});

test('all six presets round-trip back to original with no residue', () => {
  const original = { ...PRESETS.original };
  for (const name of PRESET_ORDER) {
    // simulate a switch away and back, exactly like the visualizer does
    const away = resolvePreset(name);
    assert.notEqual(away, PRESETS[name]); // fresh object, not shared mutable state
    const back = resolvePreset('original');
    assert.deepEqual(back, original, `round-trip via ${name}`);
  }
  // mutating a returned preset must never mutate the frozen source
  const copy = getPreset('original');
  copy.opacity = 0;
  assert.equal(PRESETS.original.opacity, 0.55);
});

test('unknown preset names fall back to the default, without throwing', () => {
  assert.equal(isPresetName('original'), true);
  assert.equal(isPresetName('nope'), false);
  assert.deepEqual(resolvePreset('nope'), { ...PRESETS[DEFAULT_PRESET] });
  assert.deepEqual(getPreset(undefined), { ...PRESETS[DEFAULT_PRESET] });
});

test('engine parameter clamping', () => {
  assert.equal(clampParamValue('opacity', 2), 1);
  assert.equal(clampParamValue('opacity', -1), 0);
  assert.equal(clampParamValue('opacity', '0.45'), 0.45);
  assert.equal(clampParamValue('opacity', Number.NaN), undefined);
  assert.equal(clampParamValue('notAParam', 1), undefined);
  assert.equal(clampParamValue('runnerCount', 5000), 900);
  assert.equal(clampParamValue('runnerCount', -10), 0);
});

test('visual parameter clamping (fps cap) and unknown-key rejection', () => {
  assert.equal(clampVisualParam('fpsCap', 1000), 120);
  assert.equal(clampVisualParam('fpsCap', 1), 24);
  assert.equal(clampVisualParam('fpsCap', '30.4'), 30);
  assert.equal(clampVisualParam('opacity', 0.5), undefined);
  assert.equal(clampVisualParam('fpsCap', Number.NaN), undefined);
});

test('sanitizeParams merges known keys only and never writes NaN', () => {
  const clean = sanitizeParams(
    { opacity: 9, glow: 'not-a-number', runnerCount: 400, fpsCap: 999, mystery: true },
    { opacity: 0.5, glow: 1 },
  );
  assert.equal(clean.opacity, 1);
  assert.equal(clean.glow, 1, 'invalid engine value keeps the base value');
  assert.equal(clean.runnerCount, 400);
  assert.equal(clean.fpsCap, 120);
  assert.equal(clean.mystery, undefined);
  assert.deepEqual(sanitizeParams(null, { opacity: 0.5 }), { opacity: 0.5 });
});

test('engineParamsOnly strips visualizer-only keys', () => {
  const filtered = engineParamsOnly({ ...PRESETS.original, fpsCap: 24, something: 'x' });
  assert.equal(filtered.fpsCap, undefined);
  assert.equal(filtered.something, undefined);
  assert.equal(filtered.opacity, PRESETS.original.opacity);
});

test('quality-scaled keys all exist in the engine parameter map', () => {
  for (const key of QUALITY_SCALED_KEYS) {
    assert.ok(PARAM_MAP[key], `${key} is a real engine parameter`);
  }
});
