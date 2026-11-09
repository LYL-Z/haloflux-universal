/**
 * Unit tests: packages/settings — defaults, validation and atomic persistence.
 * Contract: docs/architecture.md §9 ("Settings changes are atomic (write temp +
 * rename) and validated").
 *
 * The package API is not frozen by the architecture beyond the file shape, so
 * the test discovers the conventional export names and reports NOT_READY when
 * the module is absent. Once the module exists, the assertions are strict.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importIfExists, notReady } from '../helpers/env.mjs';

const mod = await importIfExists('packages/settings/src/index.mjs');
const skipReason = mod ? false : notReady('packages/settings/src/index.mjs is missing');

const getDefault =
  mod?.DEFAULT_SETTINGS ??
  mod?.defaultSettings ??
  mod?.DEFAULTS ??
  (typeof mod?.getDefaultSettings === 'function' ? mod.getDefaultSettings() : undefined);
const validate = mod?.validateSettings ?? mod?.validate ?? mod?.validateConfig;
const save = mod?.saveSettings ?? mod?.save ?? mod?.writeSettings;
const load = mod?.loadSettings ?? mod?.load ?? mod?.readSettings;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-settings-'));
}

function toResult(value) {
  if (value && typeof value === 'object' && 'ok' in value) return value;
  if (value === true) return { ok: true };
  if (value === false) return { ok: false, errors: [] };
  return { ok: Boolean(value) };
}

function validateSafely(input) {
  assert.ok(validate, 'settings module must export a validate function (validateSettings/validate)');
  try {
    return toResult(validate(input));
  } catch (error) {
    return { ok: false, errors: [{ message: error.message }], threw: true };
  }
}

describe('settings: defaults and validation', { skip: skipReason }, () => {
  test('module exports a defaults object, validate, save and load', () => {
    assert.ok(getDefault, 'settings module must export DEFAULT_SETTINGS (or equivalent)');
    for (const [name, fn] of Object.entries({ validate, save, load })) {
      assert.equal(typeof fn, 'function', `settings module must export ${name}`);
    }
  });

  test('defaults match docs/architecture.md §9', () => {
    const defaults = structuredClone(getDefault);
    assert.equal(defaults.schemaVersion, 1);
    assert.equal(defaults.preset, 'agent-monitor');
    assert.equal(typeof defaults.visual, 'object');
    assert.equal(defaults.visual.opacity, 0.45);
    assert.equal(defaults.visual.idleMotion, 0.18);
    assert.equal(defaults.bridge.port, 17817);
    assert.equal(defaults.companion.mode, 'window');
    assert.equal(defaults.companion.alwaysOnTop, false);
    assert.equal(defaults.companion.clickThrough, false);
    assert.equal(defaults.companion.opacity, 1);
    assert.equal(defaults.companion.bounds, null);
    assert.equal(typeof defaults.hosts, 'object');
    assert.equal(defaults.telemetry.enabled, false);
    assert.equal(validateSafely(defaults).ok, true, 'the defaults must validate');
  });

  test('validation rejects structurally bad settings', () => {
    const cases = [
      null,
      'settings',
      { ...structuredClone(getDefault), schemaVersion: 99 },
      { ...structuredClone(getDefault), preset: 'not-a-preset' },
      { ...structuredClone(getDefault), visual: { opacity: 'opaque' } },
      { ...structuredClone(getDefault), bridge: { port: 'x' } },
      { ...structuredClone(getDefault), companion: { mode: 'fullscreen' } },
    ];
    for (const candidate of cases) {
      const result = validateSafely(candidate);
      assert.equal(result.ok, false, `settings should reject ${JSON.stringify(candidate)?.slice(0, 120)}`);
    }
  });

  test('validation accepts a minimal edited default', () => {
    const candidate = structuredClone(getDefault);
    candidate.visual.opacity = 0.3;
    candidate.companion.mode = 'overlay';
    assert.equal(validateSafely(candidate).ok, true);
  });
});

describe('settings: atomic persistence', { skip: skipReason }, () => {
  test('save → load round-trips JSON and leaves no temp file', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'settings.json');
    try {
      const value = structuredClone(getDefault);
      value.visual.opacity = 0.37;
      const saved = save(file, value);
      if (saved && typeof saved.then === 'function') await saved;
      assert.ok(fs.existsSync(file), 'settings file was not written');
      const loaded = await load(file);
      assert.deepEqual(loaded, value);
      const stray = fs.readdirSync(dir).filter((name) => name !== 'settings.json');
      assert.deepEqual(stray, [], `atomic save left temp files: ${stray.join(', ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stale *.tmp file does not affect loading the real settings', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'settings.json');
    try {
      const value = structuredClone(getDefault);
      const saved = save(file, value);
      if (saved && typeof saved.then === 'function') await saved;
      const stale = path.join(dir, 'settings.json.tmp');
      fs.writeFileSync(stale, '{"this is": not json');
      const loaded = await load(file);
      assert.deepEqual(loaded, value, 'a stale temp file must not be read as settings');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rapid successive saves never produce a corrupt settings file', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'settings.json');
    try {
      const writes = [];
      for (let i = 0; i < 20; i += 1) {
        const value = structuredClone(getDefault);
        value.visual.opacity = 0.1 + i / 100;
        writes.push(Promise.resolve(save(file, value)));
      }
      await Promise.all(writes);
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      assert.equal(parsed.schemaVersion, 1);
      assert.ok(parsed.visual.opacity >= 0.099 && parsed.visual.opacity <= 0.291);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
