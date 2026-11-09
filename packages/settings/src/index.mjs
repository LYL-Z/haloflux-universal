/**
 * HALOFLUX settings — schema defaults, validation, deep merge and atomic persistence.
 *
 * Contract: docs/architecture.md §9. The settings file lives at
 * `$HALOFLUX_HOME/settings.json` (`%LOCALAPPDATA%\\HALOFLUX\\settings.json` by
 * default on Windows). Every write is atomic (temp file in the same directory +
 * fsync + rename) and validated before it can reach disk.
 *
 * Only Node built-ins are used. All functions are synchronous on purpose: the
 * Electron main process reads settings before `app.whenReady()` and the HTTP
 * bridge answers PUT /v1/settings without an extra event-loop turn.
 */

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SETTINGS_SCHEMA_VERSION = 1;

/** Window modes owned by the Electron shell. */
export const WINDOW_MODES = Object.freeze(['window', 'overlay', 'compact']);

/** Preset ids owned by packages/visual-core (contract §8). */
export const PRESETS = Object.freeze(['original', 'minimal', 'sci-fi', 'focus', 'ambient', 'agent-monitor']);

/** Hosts from the frozen event schema. */
export const HOST_IDS = Object.freeze([
  'deepseek-harness',
  'codex',
  'cursor',
  'claude-code',
  'workbuddy',
  'trae',
  'generic',
  'simulator',
]);

/** Settings body limit for PUT /v1/settings (contract §6). */
export const MAX_SETTINGS_BYTES = 64 * 1024;

const DEFAULT_HOSTS = Object.freeze(
  Object.fromEntries(HOST_IDS.map((host) => [host, Object.freeze({ enabled: true })])),
);

export const DEFAULT_SETTINGS = deepFreeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  preset: 'agent-monitor',
  visual: { opacity: 0.45, idleMotion: 0.18 },
  bridge: { port: 17817 },
  companion: { mode: 'window', alwaysOnTop: false, clickThrough: false, opacity: 1, bounds: null },
  hosts: DEFAULT_HOSTS,
  telemetry: { enabled: false },
});

/** Alias kept for callers that prefer camelCase. */
export const defaultSettings = DEFAULT_SETTINGS;

const KNOWN_TOP = new Set([
  'schemaVersion',
  'preset',
  'visual',
  'bridge',
  'companion',
  'hosts',
  'telemetry',
]);
const KNOWN_VISUAL = new Set(['opacity', 'idleMotion']);
const KNOWN_BRIDGE = new Set(['port']);
const KNOWN_COMPANION = new Set(['mode', 'alwaysOnTop', 'clickThrough', 'opacity', 'bounds']);
const KNOWN_BOUNDS = new Set(['x', 'y', 'width', 'height', 'displayId', 'scaleFactor']);
const KNOWN_HOST_SETTINGS = new Set(['enabled']);
const KNOWN_TELEMETRY = new Set(['enabled']);

/** Absolute HALOFLUX home directory ($HALOFLUX_HOME or platform default). */
export function halofluxHome(env = process.env) {
  if (env.HALOFLUX_HOME && String(env.HALOFLUX_HOME).trim()) {
    return path.resolve(String(env.HALOFLUX_HOME));
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'HALOFLUX');
  }
  const base = env.XDG_CONFIG_HOME || env.XDG_STATE_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'HALOFLUX');
}

/** `$HALOFLUX_HOME/settings.json` (or an explicit file path). */
export function settingsPath(home = halofluxHome()) {
  return path.join(home, 'settings.json');
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Structural clone that is safe for frozen defaults. */
export function cloneSettings(value) {
  return JSON.parse(JSON.stringify(value));
}

function issue(errors, issuePath, code, message) {
  errors.push({ path: issuePath, code, message });
}

function numberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate and normalize an arbitrary value into a full settings object.
 * Missing sections are filled from defaults (so partial patches are accepted).
 *
 * @returns {{ok: true, settings: object, errors: []} | {ok: false, settings: null, errors: Array}}
 */
export function validateSettings(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return {
      ok: false,
      settings: null,
      errors: [{ path: '$', code: 'not_object', message: 'settings must be a JSON object' }],
    };
  }

  for (const key of Object.keys(value)) {
    if (!KNOWN_TOP.has(key)) issue(errors, `$.${key}`, 'unknown_key', 'unknown settings key');
  }

  const settings = cloneSettings(DEFAULT_SETTINGS);

  if (value.schemaVersion !== undefined && value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    issue(errors, 'schemaVersion', 'bad_schema_version', `expected ${SETTINGS_SCHEMA_VERSION}`);
  }

  if (value.preset !== undefined) {
    if (typeof value.preset !== 'string' || !PRESETS.includes(value.preset)) {
      issue(errors, 'preset', 'bad_preset', `preset must be one of ${PRESETS.join(', ')}`);
    } else {
      settings.preset = value.preset;
    }
  }

  const visual = objectSection(value, 'visual', KNOWN_VISUAL, errors);
  if (visual) {
    if (visual.opacity !== undefined) {
      if (!numberInRange(visual.opacity, 0, 1)) issue(errors, 'visual.opacity', 'bad_number', 'opacity must be 0..1');
      else settings.visual.opacity = visual.opacity;
    }
    if (visual.idleMotion !== undefined) {
      if (!numberInRange(visual.idleMotion, 0, 1)) issue(errors, 'visual.idleMotion', 'bad_number', 'idleMotion must be 0..1');
      else settings.visual.idleMotion = visual.idleMotion;
    }
  }

  const bridge = objectSection(value, 'bridge', KNOWN_BRIDGE, errors);
  if (bridge && bridge.port !== undefined) {
    if (!Number.isInteger(bridge.port) || bridge.port < 0 || bridge.port > 65535) {
      issue(errors, 'bridge.port', 'bad_port', 'port must be an integer 0..65535 (0 = OS-assigned)');
    } else {
      settings.bridge.port = bridge.port;
    }
  }

  const companion = objectSection(value, 'companion', KNOWN_COMPANION, errors);
  if (companion) {
    if (companion.mode !== undefined) {
      if (typeof companion.mode !== 'string' || !WINDOW_MODES.includes(companion.mode)) {
        issue(errors, 'companion.mode', 'bad_mode', `mode must be one of ${WINDOW_MODES.join(', ')}`);
      } else {
        settings.companion.mode = companion.mode;
      }
    }
    for (const key of ['alwaysOnTop', 'clickThrough']) {
      if (companion[key] !== undefined) {
        if (typeof companion[key] !== 'boolean') issue(errors, `companion.${key}`, 'bad_boolean', 'must be a boolean');
        else settings.companion[key] = companion[key];
      }
    }
    if (companion.opacity !== undefined) {
      if (!numberInRange(companion.opacity, 0, 1)) issue(errors, 'companion.opacity', 'bad_number', 'opacity must be 0..1');
      else settings.companion.opacity = companion.opacity;
    }
    if (companion.bounds !== undefined) {
      if (companion.bounds === null) {
        settings.companion.bounds = null;
      } else {
        const bounds = validateBounds(companion.bounds, errors);
        if (bounds) {
          settings.companion.bounds = bounds;
        }
      }
    }
  }

  if (value.hosts !== undefined) {
    if (!isPlainObject(value.hosts)) {
      issue(errors, 'hosts', 'bad_object', 'hosts must be an object');
    } else {
      for (const [host, hostSettings] of Object.entries(value.hosts)) {
        if (!HOST_IDS.includes(host)) {
          issue(errors, `hosts.${host}`, 'unknown_host', 'host is not part of schemaVersion 1');
          continue;
        }
        if (!isPlainObject(hostSettings)) {
          issue(errors, `hosts.${host}`, 'bad_object', 'host settings must be an object');
          continue;
        }
        for (const key of Object.keys(hostSettings)) {
          if (!KNOWN_HOST_SETTINGS.has(key)) issue(errors, `hosts.${host}.${key}`, 'unknown_key', 'unknown host setting');
        }
        if (hostSettings.enabled !== undefined) {
          if (typeof hostSettings.enabled !== 'boolean') {
            issue(errors, `hosts.${host}.enabled`, 'bad_boolean', 'enabled must be a boolean');
          } else {
            settings.hosts[host] = { enabled: hostSettings.enabled };
          }
        }
      }
    }
  }

  const telemetry = objectSection(value, 'telemetry', KNOWN_TELEMETRY, errors);
  if (telemetry && telemetry.enabled !== undefined) {
    if (typeof telemetry.enabled !== 'boolean') issue(errors, 'telemetry.enabled', 'bad_boolean', 'enabled must be a boolean');
    else settings.telemetry.enabled = telemetry.enabled;
  }

  if (errors.length > 0) return { ok: false, settings: null, errors };
  return { ok: true, settings, errors: [] };
}

function objectSection(value, key, knownKeys, errors) {
  if (value[key] === undefined) return undefined;
  if (!isPlainObject(value[key])) {
    issue(errors, key, 'bad_object', `${key} must be an object`);
    return undefined;
  }
  for (const child of Object.keys(value[key])) {
    if (!knownKeys.has(child)) issue(errors, `${key}.${child}`, 'unknown_key', 'unknown settings key');
  }
  return value[key];
}

function validateBounds(bounds, errors) {
  if (!isPlainObject(bounds)) {
    issue(errors, 'companion.bounds', 'bad_bounds', 'bounds must be null or an object');
    return null;
  }
  for (const key of Object.keys(bounds)) {
    if (!KNOWN_BOUNDS.has(key)) issue(errors, `companion.bounds.${key}`, 'unknown_key', 'unknown bounds key');
  }
  const out = {};
  for (const key of ['x', 'y']) {
    if (bounds[key] === undefined) continue;
    if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])) {
      issue(errors, `companion.bounds.${key}`, 'bad_number', 'must be a finite number');
    } else out[key] = bounds[key];
  }
  for (const key of ['width', 'height']) {
    if (bounds[key] === undefined) continue;
    if (!numberInRange(bounds[key], 1, 100000)) {
      issue(errors, `companion.bounds.${key}`, 'bad_number', 'must be a number >= 1');
    } else out[key] = bounds[key];
  }
  if (bounds.displayId !== undefined) {
    if (!Number.isInteger(bounds.displayId) || bounds.displayId < 0) {
      issue(errors, 'companion.bounds.displayId', 'bad_number', 'displayId must be an integer >= 0');
    } else out.displayId = bounds.displayId;
  }
  if (bounds.scaleFactor !== undefined) {
    if (!numberInRange(bounds.scaleFactor, 0.5, 8)) {
      issue(errors, 'companion.bounds.scaleFactor', 'bad_number', 'scaleFactor must be 0.5..8');
    } else out.scaleFactor = bounds.scaleFactor;
  }
  if (out.width === undefined || out.height === undefined) {
    issue(errors, 'companion.bounds', 'bad_bounds', 'bounds requires width and height');
    return null;
  }
  return out;
}

/** Normalize or throw an Error with `.code` and `.issues`. */
export function normalizeSettings(value) {
  const result = validateSettings(value);
  if (!result.ok) {
    const error = new Error(`invalid settings: ${result.errors.length} issue(s)`);
    error.code = 'INVALID_SETTINGS';
    error.issues = result.errors;
    throw error;
  }
  return result.settings;
}

/** Alias: QA/tests may prefer a throwing helper with an explicit name. */
export function assertValidSettings(value) {
  return normalizeSettings(value);
}

function collectPatchIssues(patch, errors, basePath = '') {
  if (!isPlainObject(patch)) {
    issue(errors, basePath || '$', 'not_object', 'patch must be a JSON object');
    return;
  }
  for (const key of Object.keys(patch)) {
    if (basePath === '') {
      if (!KNOWN_TOP.has(key)) issue(errors, key, 'unknown_key', 'unknown settings key');
      if (['visual', 'bridge', 'companion', 'telemetry', 'hosts'].includes(key) && key !== 'hosts') {
        if (!isPlainObject(patch[key])) issue(errors, key, 'bad_object', `${key} must be an object`);
      }
      if (key === 'hosts') {
        if (!isPlainObject(patch.hosts)) {
          issue(errors, 'hosts', 'bad_object', 'hosts must be an object');
          continue;
        }
        for (const [host, hostPatch] of Object.entries(patch.hosts)) {
          if (!isPlainObject(hostPatch)) issue(errors, `hosts.${host}`, 'bad_object', 'host settings must be an object');
        }
      }
    }
  }
}

/**
 * Deep merge a validated patch over base settings. Only known branches are
 * merged; `bounds: null` clears the persisted bounds. Throws on invalid patch.
 */
export function mergeSettings(base, patch) {
  const errors = [];
  collectPatchIssues(patch, errors);
  if (errors.length > 0) {
    const error = new Error(`invalid settings patch: ${errors.length} issue(s)`);
    error.code = 'INVALID_SETTINGS';
    error.issues = errors;
    throw error;
  }
  const merged = cloneSettings(base);
  for (const key of ['schemaVersion', 'preset']) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  for (const key of ['visual', 'bridge', 'companion', 'telemetry']) {
    if (isPlainObject(patch[key])) merged[key] = { ...merged[key], ...patch[key] };
  }
  if (isPlainObject(patch.hosts)) {
    for (const [host, hostPatch] of Object.entries(patch.hosts)) {
      merged.hosts[host] = { ...(merged.hosts[host] || {}), ...hostPatch };
    }
  }
  return normalizeSettings(merged);
}

function attachWarnings(settings, warnings) {
  if (!warnings || warnings.length === 0) return settings;
  Object.defineProperty(settings, '__warnings', {
    value: Object.freeze([...warnings]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return settings;
}

/** Warnings produced by the last load (invalid/corrupt file fell back to defaults). */
export function settingsWarnings(settings) {
  return settings && Array.isArray(settings.__warnings) ? settings.__warnings : [];
}

/**
 * Load settings from a JSON file path. Missing files and corrupt/invalid files
 * fall back to defaults; corruption is reported through non-enumerable
 * `__warnings` instead of throwing so the companion always starts.
 */
export function loadSettings(filePath = settingsPath()) {
  let text;
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_SETTINGS_BYTES) {
      return attachWarnings(cloneSettings(DEFAULT_SETTINGS), [
        `settings-too-large:${stat.size}>${MAX_SETTINGS_BYTES}`,
        'using-default-settings',
      ]);
    }
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return cloneSettings(DEFAULT_SETTINGS);
    return attachWarnings(cloneSettings(DEFAULT_SETTINGS), [
      `settings-read-failed:${error && error.code ? error.code : 'unknown'}`,
      'using-default-settings',
    ]);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return attachWarnings(cloneSettings(DEFAULT_SETTINGS), ['settings-json-invalid', 'using-default-settings']);
  }
  const result = validateSettings(parsed);
  if (!result.ok) {
    return attachWarnings(cloneSettings(DEFAULT_SETTINGS), [
      `settings-invalid:${result.errors.length}-issue(s)`,
      'using-default-settings',
    ]);
  }
  return result.settings;
}

function atomicWrite(filePath, text) {
  const directory = path.dirname(path.resolve(filePath));
  mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  let fd;
  try {
    fd = openSync(tempPath, 'w', 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      /* Windows maps chmod to the read-only bit; best effort per contract. */
    }
    renameSync(tempPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best effort */
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Validate + atomically persist settings. Returns the normalized settings. */
export function saveSettings(filePath = settingsPath(), value = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(value);
  atomicWrite(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

/** Load, deep-merge a partial patch, validate and persist; returns saved settings. */
export function updateSettings(filePath = settingsPath(), patch = {}) {
  const current = loadSettings(filePath);
  const merged = mergeSettings(current, patch);
  atomicWrite(filePath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/** Convenience used by the Electron main process. */
export function loadOrCreateSettings(filePath = settingsPath()) {
  const settings = loadSettings(filePath);
  const stat = (() => {
    try {
      statSync(filePath);
      return true;
    } catch {
      return false;
    }
  })();
  if (!stat) {
    try {
      saveSettings(filePath, settings);
    } catch {
      /* read-only profile: keep in-memory defaults */
    }
  }
  return loadSettings(filePath);
}
