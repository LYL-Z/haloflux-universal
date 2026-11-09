import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  MAX_SETTINGS_BYTES,
  PRESETS,
  cloneSettings,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  saveSettings,
  settingsPath,
  settingsWarnings,
  updateSettings,
  validateSettings,
} from '../src/index.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-settings-test-'));
}

test('DEFAULT_SETTINGS matches the contract §9 shape', () => {
  assert.equal(DEFAULT_SETTINGS.schemaVersion, 1);
  assert.equal(DEFAULT_SETTINGS.preset, 'agent-monitor');
  assert.deepEqual(DEFAULT_SETTINGS.visual, { opacity: 0.45, idleMotion: 0.18 });
  assert.deepEqual(DEFAULT_SETTINGS.bridge, { port: 17817 });
  assert.deepEqual(DEFAULT_SETTINGS.companion, {
    mode: 'window',
    alwaysOnTop: false,
    clickThrough: false,
    opacity: 1,
    bounds: null,
  });
  assert.equal(DEFAULT_SETTINGS.hosts['claude-code'].enabled, true);
  assert.equal(DEFAULT_SETTINGS.telemetry.enabled, false);
  assert.equal(MAX_SETTINGS_BYTES, 64 * 1024);
  assert.deepEqual(PRESETS, ['original', 'minimal', 'sci-fi', 'focus', 'ambient', 'agent-monitor']);
});

test('validateSettings accepts defaults and fills missing sections from defaults', () => {
  const defaults = validateSettings(cloneSettings(DEFAULT_SETTINGS));
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.settings, DEFAULT_SETTINGS);

  const partial = validateSettings({ preset: 'focus' });
  assert.equal(partial.ok, true);
  assert.equal(partial.settings.preset, 'focus');
  assert.equal(partial.settings.visual.opacity, 0.45);
});

test('validateSettings rejects bad values with path/code issues', () => {
  const cases = [
    [{ preset: 'bogus' }, 'preset'],
    [{ visual: { opacity: 2 } }, 'visual.opacity'],
    [{ bridge: { port: 99999 } }, 'bridge.port'],
    [{ companion: { mode: 'fullscreen' } }, 'companion.mode'],
    [{ companion: { bounds: { width: 0, height: 0 } } }, 'companion.bounds'],
    [{ unknownSection: {} }, '$.unknownSection'],
    [{ hosts: { 'not-a-host': { enabled: true } } }, 'hosts.not-a-host'],
  ];
  for (const [value, expectedPath] of cases) {
    const result = validateSettings(value);
    assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to fail`);
    assert.equal(result.settings, null);
    assert.ok(result.errors.some((issue) => issue.path === expectedPath), `missing issue for ${expectedPath}`);
  }
});

test('saveSettings is atomic and loadSettings round-trips the file', () => {
  const dir = tempDir();
  try {
    const file = settingsPath(dir);
    const saved = saveSettings(file, {
      ...cloneSettings(DEFAULT_SETTINGS),
      preset: 'minimal',
      companion: { ...DEFAULT_SETTINGS.companion, mode: 'overlay', opacity: 0.8 },
    });
    assert.equal(saved.preset, 'minimal');
    assert.equal(fs.existsSync(file), true);
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /"schemaVersion": 1/);
    assert.deepEqual(loadSettings(file), saved);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSettings throws INVALID_SETTINGS before touching disk', () => {
  const dir = tempDir();
  try {
    const file = settingsPath(dir);
    const error = (() => {
      try {
        saveSettings(file, { preset: 'nope' });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    assert.ok(error);
    assert.equal(error.code, 'INVALID_SETTINGS');
    assert.ok(Array.isArray(error.issues) && error.issues.length > 0);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateSettings deep-merges a partial patch and preserves other fields', () => {
  const dir = tempDir();
  try {
    const file = settingsPath(dir);
    updateSettings(file, { preset: 'sci-fi', visual: { opacity: 0.7 } });
    const updated = updateSettings(file, { companion: { mode: 'compact', clickThrough: true } });
    assert.equal(updated.preset, 'sci-fi');
    assert.equal(updated.visual.opacity, 0.7);
    assert.equal(updated.visual.idleMotion, 0.18);
    assert.equal(updated.companion.mode, 'compact');
    assert.equal(updated.companion.clickThrough, true);
    assert.equal(loadSettings(file).companion.mode, 'compact');

    assert.throws(() => updateSettings(file, { preset: 'bad' }), (error) => error.code === 'INVALID_SETTINGS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeSettings applies bounds: null as an explicit clear', () => {
  const base = normalizeSettings({
    companion: { bounds: { x: 10, y: 20, width: 800, height: 600, displayId: 1, scaleFactor: 1.5 } },
  });
  const cleared = mergeSettings(base, { companion: { bounds: null } });
  assert.equal(cleared.companion.bounds, null);

  const moved = mergeSettings(base, { companion: { bounds: { x: 100, y: 200, width: 900, height: 700 } } });
  assert.deepEqual(moved.companion.bounds, { x: 100, y: 200, width: 900, height: 700 });
});

test('loadSettings falls back to defaults for missing, corrupt and invalid files', () => {
  const dir = tempDir();
  try {
    const missing = loadSettings(path.join(dir, 'does-not-exist.json'));
    assert.deepEqual(missing, DEFAULT_SETTINGS);
    assert.deepEqual(settingsWarnings(missing), []);

    const corruptFile = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corruptFile, '{ definitely not json');
    const corrupt = loadSettings(corruptFile);
    assert.deepEqual(corrupt, DEFAULT_SETTINGS);
    assert.ok(settingsWarnings(corrupt).includes('settings-json-invalid'));

    const invalidFile = path.join(dir, 'invalid.json');
    fs.writeFileSync(invalidFile, JSON.stringify({ preset: 'nope' }));
    const invalid = loadSettings(invalidFile);
    assert.deepEqual(invalid, DEFAULT_SETTINGS);
    assert.ok(settingsWarnings(invalid).some((warning) => warning.startsWith('settings-invalid')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds persistence keeps display/scale metadata and validates it', () => {
  const dir = tempDir();
  try {
    const file = settingsPath(dir);
    const saved = saveSettings(file, {
      companion: { mode: 'overlay', bounds: { x: -100, y: 50, width: 1920, height: 1080, displayId: 2, scaleFactor: 1.25 } },
    });
    assert.deepEqual(saved.companion.bounds, {
      x: -100,
      y: 50,
      width: 1920,
      height: 1080,
      displayId: 2,
      scaleFactor: 1.25,
    });
    const reloaded = loadSettings(file);
    assert.deepEqual(reloaded.companion.bounds, saved.companion.bounds);

    const invalid = validateSettings({ companion: { bounds: { width: 800 } } });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors[0].path, 'companion.bounds');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings rejects files above the 64 KB budget', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'big.json');
    fs.writeFileSync(file, '{"pad":"' + 'x'.repeat(MAX_SETTINGS_BYTES + 10) + '"}');
    const loaded = loadSettings(file);
    assert.deepEqual(loaded, DEFAULT_SETTINGS);
    assert.ok(settingsWarnings(loaded).some((warning) => warning.startsWith('settings-too-large')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_SETTINGS is frozen and cloneSettings returns an independent copy', () => {
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.companion), true);
  const copy = cloneSettings(DEFAULT_SETTINGS);
  copy.preset = 'focus';
  assert.equal(DEFAULT_SETTINGS.preset, 'agent-monitor');
});
