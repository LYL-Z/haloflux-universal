/**
 * HALOFLUX — host config installer/uninstaller engine.
 *
 * One implementation for every JSON-config host adapter. The `.ps1` scripts in
 * `adapters/<host>/` and `scripts/` are thin wrappers around this file so the
 * merge/backup/rollback logic exists exactly once.
 *
 * Safety model (architecture §10.6/§10.7):
 *  1. read the host config and hash it (SHA256);
 *  2. copy the original bytes into `config/backups/<utc-ts>/<basename>`;
 *  3. deep-merge only OUR entries (identified by the `haloflux` marker in the
 *     command), never touching unrelated keys/entries;
 *  4. write atomically (tmp + rename);
 *  5. write `manifest.json` with before/after hashes and the exact entries;
 *  6. uninstall restores the backup byte-for-byte when the file is unchanged
 *     since install, otherwise it removes only our entries and reports drift.
 *
 * Exit codes: 0 success, 1 error, 2 usage error. Never used as a host hook.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, readdirSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { writeHostVersion, ADAPTER_VERSION } from './event-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const DEFAULT_BACKUP_ROOT = path.join(REPO_ROOT, 'config', 'backups');
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:17817';
const MARKER = 'haloflux';

/* ------------------------------------------------------------------- hosts */

const HOSTS = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    configRoot: () => path.join(homedir(), '.claude'),
    configFile: 'settings.json',
    adapter: 'claude-code',
    format: 'claude',
    versionCommand: ['claude', ['--version']],
    events: [
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
      'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd',
    ],
    hookTimeout: 5,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    configRoot: () => path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex')),
    configFile: 'hooks.json',
    adapter: 'codex',
    format: 'nested',
    versionCommand: ['codex', ['--version']],
    events: [
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
      'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop',
    ],
    hookTimeout: 10,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    configRoot: () => path.join(homedir(), '.cursor'),
    configFile: 'hooks.json',
    adapter: 'cursor',
    format: 'flat',
    versionCommand: null,
    events: [
      'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse',
      'postToolUse', 'postToolUseFailure', 'stop', 'beforeShellExecution',
      'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution',
    ],
    hookTimeout: 5,
  },
  trae: {
    id: 'trae',
    label: 'TRAE CN',
    configRoot: () => path.join(homedir(), '.trae-cn'),
    configFile: 'hooks.json',
    adapter: 'trae',
    format: 'flat',
    versionCommand: null,
    events: [
      'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop',
    ],
    hookTimeout: 5,
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    configRoot: () => path.join(homedir(), '.workbuddy'),
    configFile: 'mcp.json',
    adapter: 'workbuddy',
    format: 'mcp',
    versionCommand: null,
    events: [],
    hookTimeout: 5,
  },
};

/* ------------------------------------------------------------------ helpers */

const nowStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');

/** A backup dir per install; never collide or overwrite an existing manifest. */
function uniqueBackupDir(backupRoot) {
  const base = nowStamp();
  let candidate = path.join(backupRoot, base);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(backupRoot, `${base}-${index}`);
    index += 1;
  }
  return candidate;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readConfig(file) {
  if (!existsSync(file)) return { exists: false, text: '', data: null };
  const text = readFileSync(file, 'utf8');
  // Hash/backup keep the raw bytes; parsing tolerates a UTF-8 BOM (some editors
  // and PowerShell add one) without ever writing it back.
  const parseable = text.replace(/^\uFEFF/, '');
  const data = parseable.trim() === '' ? {} : JSON.parse(parseable);
  return { exists: true, text, data };
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.haloflux-tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOurCommand(value) {
  return typeof value === 'string' && value.toLowerCase().includes(MARKER);
}

function detectVersion(host) {
  const spec = HOSTS[host];
  if (!spec) return '';
  if (spec.versionCommand) {
    const [command, args] = spec.versionCommand;
    try {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, shell: true });
      if (result.status !== 0) return '';
      const text = `${result.stdout || ''} ${result.stderr || ''}`.trim();
      const match = text.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
      return match ? match[0] : '';
    } catch {
      return '';
    }
  }
  // GUI-only hosts: read the executable's PE product version.
  const candidates = APP_VERSION_PATHS[host] || [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const result = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Item -LiteralPath '${candidate.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
      ], { encoding: 'utf8', timeout: 20000 });
      const value = `${result.stdout || ''}`.trim();
      const match = value.match(/\d+(?:\.\d+){1,3}/);
      if (match) return match[0];
    } catch {
      /* try next candidate */
    }
  }
  return '';
}

const APP_VERSION_PATHS = {
  cursor: [
    'D:\\cursor\\Cursor.exe',
    path.join(homedir(), 'AppData', 'Local', 'Programs', 'Cursor', 'Cursor.exe'),
  ],
  trae: [
    path.join(homedir(), 'AppData', 'Local', 'Programs', 'Trae CN', 'Trae CN.exe'),
  ],
  workbuddy: [
    path.join(homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  ],
};

function nodeExecutable() {
  return process.execPath;
}

/** Build the command string a host will run for our hook. */
function hookCommand(host, nodePath) {
  const adapterPath = path.join(REPO_ROOT, 'adapters', HOSTS[host].adapter, 'adapter.mjs');
  return `"${nodePath}" "${adapterPath}"`;
}

/* ----------------------------------------------------------- merge per format */

/**
 * Claude Code: settings.json -> hooks[event] = [{matcher?, hooks:[{type,command,timeout}]}]
 * Codex:       hooks.json   -> hooks[event] = [{matcher?, hooks:[{type,command,timeout}]}]
 */
function mergeNested(data, events, command, timeout) {
  const result = isPlainObject(data) ? { ...data } : {};
  const hooks = isPlainObject(result.hooks) ? { ...result.hooks } : {};
  let added = 0;
  let removed = 0;
  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = existing.filter((group) => {
      const inner = Array.isArray(group?.hooks) ? group.hooks : [];
      return !inner.some((hook) => isOurCommand(hook?.command));
    });
    removed += existing.length - kept.length;
    kept.push({ hooks: [{ type: 'command', command, timeout }] });
    added += 1;
    hooks[event] = kept;
  }
  result.hooks = hooks;
  return { data: result, added, removed };
}

/**
 * Cursor / TRAE: hooks.json -> {version:1, hooks:{event:[{command,type,timeout}]}}
 */
function mergeFlat(data, events, command, timeout) {
  const result = isPlainObject(data) ? { ...data } : {};
  if (result.version === undefined) result.version = 1;
  const hooks = isPlainObject(result.hooks) ? { ...result.hooks } : {};
  let added = 0;
  let removed = 0;
  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = existing.filter((entry) => !isOurCommand(entry?.command));
    removed += existing.length - kept.length;
    kept.push({ command, type: 'command', timeout });
    added += 1;
    hooks[event] = kept;
  }
  result.hooks = hooks;
  return { data: result, added, removed };
}

/** WorkBuddy: mcp.json -> {mcpServers:{"haloflux-status":{command,args,env}}} */
function mergeMcp(data, host, nodePath, bridgeUrl) {
  const result = isPlainObject(data) ? { ...data } : {};
  const servers = isPlainObject(result.mcpServers) ? { ...result.mcpServers } : {};
  const entry = {
    command: nodePath,
    args: [path.join(REPO_ROOT, 'adapters', HOSTS[host].adapter, 'mcp-server.mjs')],
    env: { HALOFLUX_BRIDGE_URL: bridgeUrl },
  };
  const existed = Boolean(servers['haloflux-status']);
  servers['haloflux-status'] = entry;
  result.mcpServers = servers;
  return { data: result, added: 1, removed: existed ? 1 : 0, entry };
}

function unmergeNested(data, events) {
  const result = isPlainObject(data) ? { ...data } : {};
  if (!isPlainObject(result.hooks)) return { data: result, removed: 0 };
  const hooks = { ...result.hooks };
  let removed = 0;
  for (const event of events) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((group) => {
      const inner = Array.isArray(group?.hooks) ? group.hooks : [];
      return !inner.some((hook) => isOurCommand(hook?.command));
    });
    removed += hooks[event].length - kept.length;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  else delete result.hooks;
  return { data: result, removed };
}

function unmergeFlat(data, events) {
  const result = isPlainObject(data) ? { ...data } : {};
  if (!isPlainObject(result.hooks)) return { data: result, removed: 0 };
  const hooks = { ...result.hooks };
  let removed = 0;
  for (const event of events) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((entry) => !isOurCommand(entry?.command));
    removed += hooks[event].length - kept.length;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  else delete result.hooks;
  return { data: result, removed };
}

function unmergeMcp(data) {
  const result = isPlainObject(data) ? { ...data } : {};
  if (!isPlainObject(result.mcpServers) || !result.mcpServers['haloflux-status']) {
    return { data: result, removed: 0 };
  }
  const servers = { ...result.mcpServers };
  delete servers['haloflux-status'];
  result.mcpServers = servers;
  return { data: result, removed: 1 };
}

/* ---------------------------------------------------------------- manifests */

const MANIFEST_NAME = 'manifest.json';

export function findLatestManifest(backupRoot, host) {
  try {
    if (!existsSync(backupRoot)) return undefined;
    const dirs = readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const dir of dirs) {
      const file = path.join(backupRoot, dir, MANIFEST_NAME);
      if (!existsSync(file)) continue;
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest.host === host && !manifest.uninstalled) return { manifest, dir: path.join(backupRoot, dir) };
      } catch { /* skip corrupt manifest */ }
    }
  } catch { /* ignore */ }
  return undefined;
}

/* ------------------------------------------------------------------- engine */

function parseArgs(argv) {
  const out = { action: 'install' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'json' || key === 'dry-run' || key === 'force') { out[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { out[key] = true; continue; }
    out[key] = value;
    i += 1;
  }
  return out;
}

function defaultBackupRoot() {
  return process.env.HALOFLUX_BACKUP_ROOT || DEFAULT_BACKUP_ROOT;
}

function printSummary(summary, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(`HALOFLUX adapter ${summary.action} — ${summary.hostLabel} (${summary.host})`);
  lines.push(`  config     : ${summary.configPath}`);
  lines.push(`  status     : ${summary.status}`);
  lines.push(`  before     : ${summary.beforeSha256}`);
  lines.push(`  after      : ${summary.afterSha256}`);
  if (summary.backupDir) lines.push(`  backup     : ${summary.backupDir}`);
  if (summary.manifestPath) lines.push(`  manifest   : ${summary.manifestPath}`);
  if (summary.added !== undefined) lines.push(`  entries    : +${summary.added} / -${summary.removed}`);
  if (summary.hostVersion) lines.push(`  hostVersion: ${summary.hostVersion}`);
  if (summary.note) lines.push(`  note       : ${summary.note}`);
  if (summary.diff && summary.diff.length) {
    lines.push('  diff       :');
    for (const line of summary.diff) lines.push(`    - ${line}`);
  }
  lines.push(`  rollback   : ${summary.rollbackCommand}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function install(host, opts) {
  const spec = HOSTS[host];
  if (!spec) throw new Error(`unknown host: ${host}`);
  const configRoot = opts['config-root'] ? path.resolve(opts['config-root']) : spec.configRoot();
  const configPath = path.join(configRoot, spec.configFile);
  const backupRoot = opts['backup-root'] ? path.resolve(opts['backup-root']) : defaultBackupRoot();
  const bridgeUrl = opts['bridge-url'] || DEFAULT_BRIDGE_URL;
  const nodePath = opts.node && opts.node !== true ? opts.node : nodeExecutable();

  if (host === 'trae' && opts.mode !== 'Hooks') {
    const summary = {
      action: 'install', host, hostLabel: spec.label, status: 'SKIPPED-UNVERIFIED',
      configPath, beforeSha256: '-', afterSha256: '-',
      added: 0, removed: 0, note: 'TRAE hook file format is unverified on 3.4.13; pass -Mode Hooks to force (see README).',
      rollbackCommand: 'not installed — nothing to roll back',
    };
    printSummary(summary, opts.json);
    return summary;
  }

  const current = readConfig(configPath);
  const beforeText = current.text;
  const currentSha256 = current.exists ? sha256(beforeText) : 'MISSING';
  const hostVersion = opts['host-version'] && opts['host-version'] !== true
    ? String(opts['host-version'])
    : detectVersion(host);

  // Idempotent re-install: when the previous install's output is still intact,
  // keep its ORIGINAL pre-install backup/manifest so uninstall can always roll
  // all the way back to the true original bytes.
  const previous = findLatestManifest(backupRoot, host);
  const reusePrevious = Boolean(previous)
    && previous.manifest.configPath === configPath
    && ((current.exists && currentSha256 === previous.manifest.afterSha256)
      || (!current.exists && previous.manifest.createdFile));

  let merged;
  const command = hookCommand(host, nodePath);
  if (spec.format === 'claude' || spec.format === 'nested') {
    merged = mergeNested(current.data, spec.events, command, spec.hookTimeout);
  } else if (spec.format === 'flat') {
    merged = mergeFlat(current.data, spec.events, command, spec.hookTimeout);
  } else if (spec.format === 'mcp') {
    merged = mergeMcp(current.data, host, nodePath, bridgeUrl);
  } else {
    throw new Error(`unsupported config format: ${spec.format}`);
  }

  const afterText = jsonText(merged.data);
  const afterSha256 = sha256(afterText);

  const dir = reusePrevious ? previous.dir : uniqueBackupDir(backupRoot);
  const backupFile = path.join(dir, spec.configFile);
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const beforeSha256 = reusePrevious ? previous.manifest.beforeSha256 : currentSha256;
  const createdFile = reusePrevious ? previous.manifest.createdFile : !current.exists;

  const summary = {
    action: 'install',
    host,
    hostLabel: spec.label,
    status: opts['dry-run'] ? 'DRY-RUN' : 'INSTALLED',
    configPath,
    beforeSha256,
    afterSha256,
    backupDir: dir,
    manifestPath,
    added: merged.added,
    removed: merged.removed,
    hostVersion,
    bridgeUrl,
    nodePath,
    createdFile,
    reusedManifest: reusePrevious,
    note: reusePrevious ? 'reinstall: kept the original pre-install backup/manifest' : '',
    rollbackCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(REPO_ROOT, 'adapters', host, 'uninstall.ps1')}"`,
  };

  if (opts['dry-run']) {
    printSummary(summary, opts.json);
    return summary;
  }

  mkdirSync(dir, { recursive: true });
  if (!reusePrevious) {
    if (current.exists) writeFileSync(backupFile, beforeText, 'utf8');
    else writeFileSync(path.join(dir, '.missing'), 'config did not exist before install\n', 'utf8');
  }

  const manifest = {
    schemaVersion: 1,
    tool: 'haloflux-adapters',
    installerVersion: ADAPTER_VERSION,
    host,
    hostLabel: spec.label,
    action: 'install',
    createdAt: reusePrevious ? previous.manifest.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reinstallCount: reusePrevious ? (previous.manifest.reinstallCount || 0) + 1 : 0,
    configPath,
    backupPath: createdFile ? null : backupFile,
    createdFile,
    beforeSha256,
    afterSha256,
    entries: spec.format === 'mcp'
      ? [{ type: 'mcpServer', name: 'haloflux-status', command: nodePath, args: merged.entry.args }]
      : spec.events.map((event) => ({ event, command })),
    hostVersion: hostVersion || (reusePrevious ? previous.manifest.hostVersion : ''),
    bridgeUrl,
    nodePath,
    adapterPath: path.join(REPO_ROOT, 'adapters', spec.adapter, 'adapter.mjs'),
    rollback: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(REPO_ROOT, 'adapters', host, 'uninstall.ps1')}"`,
  };

  if (hostVersion) writeHostVersion(host, hostVersion);
  writeAtomic(configPath, afterText);
  writeFileSync(manifestPath, jsonText(manifest), 'utf8');

  // Re-hash what is actually on disk — proof the summary is not aspirational.
  const written = readFileSync(configPath, 'utf8');
  if (sha256(written) !== afterSha256) throw new Error('post-write hash mismatch');
  summary.afterSha256 = sha256(written);
  printSummary(summary, opts.json);
  return summary;
}

function uninstall(host, opts) {
  const spec = HOSTS[host];
  if (!spec) throw new Error(`unknown host: ${host}`);
  const backupRoot = opts['backup-root'] ? path.resolve(opts['backup-root']) : defaultBackupRoot();
  let found;
  if (opts.manifest && opts.manifest !== true) {
    const manifestPath = path.resolve(opts.manifest);
    found = { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), dir: path.dirname(manifestPath) };
  } else {
    found = findLatestManifest(backupRoot, host);
  }
  if (!found) {
    const summary = {
      action: 'uninstall', host, hostLabel: spec.label, status: 'NO-MANIFEST',
      configPath: '-', beforeSha256: '-', afterSha256: '-', added: 0, removed: 0,
      note: `no installed manifest for ${host} under ${backupRoot}`,
      rollbackCommand: 'n/a',
    };
    printSummary(summary, opts.json);
    return summary;
  }

  const { manifest } = found;
  const configPath = manifest.configPath;
  const current = readConfig(configPath);
  const currentSha256 = current.exists ? sha256(current.text) : 'MISSING';
  const summary = {
    action: 'uninstall',
    host,
    hostLabel: spec.label,
    status: '',
    configPath,
    beforeSha256: manifest.beforeSha256,
    afterSha256: currentSha256,
    backupDir: found.dir,
    manifestPath: path.join(found.dir, MANIFEST_NAME),
    added: 0,
    removed: 0,
    hostVersion: manifest.hostVersion || '',
    note: '',
    diff: [],
    rollbackCommand: `re-install: ${path.join(REPO_ROOT, 'scripts', 'install-adapters.ps1')} -Hosts ${host}`,
  };

  const clean = currentSha256 === manifest.afterSha256;
  if (clean) {
    // Nothing changed since install: restore the exact original bytes.
    if (opts['dry-run']) {
      summary.status = manifest.createdFile ? 'DRY-RUN-WOULD-REMOVE-CREATED-FILE' : 'DRY-RUN-WOULD-RESTORE';
      summary.note = manifest.createdFile
        ? 'config file was created by the installer; a real uninstall deletes it'
        : 'config matches the post-install hash; a real uninstall restores the backup';
      summary.afterSha256 = currentSha256;
    } else if (manifest.createdFile) {
      if (current.exists) unlinkSync(configPath);
      summary.status = 'REMOVED-CREATED-FILE';
      summary.note = 'config file did not exist before install; removed';
      summary.afterSha256 = existsSync(configPath) ? sha256(readFileSync(configPath, 'utf8')) : 'MISSING';
    } else {
      writeAtomic(configPath, manifest.backupPath ? readFileSync(manifest.backupPath, 'utf8') : '');
      summary.status = 'RESTORED-BYTE-IDENTICAL';
      summary.note = 'config matched the post-install hash; restored the pre-install backup';
      const restoredSha256 = existsSync(configPath) ? sha256(readFileSync(configPath, 'utf8')) : 'MISSING';
      summary.afterSha256 = restoredSha256;
      if (restoredSha256 !== manifest.beforeSha256) {
        summary.status = 'RESTORE-HASH-MISMATCH';
        summary.note = 'restored file hash does not match the recorded pre-install hash';
      }
    }
  } else {
    // Host changed after install (e.g. AgentHaven rewrote settings.json):
    // remove only our entries and report the drift; never clobber user changes.
    let result;
    if (spec.format === 'claude' || spec.format === 'nested') result = unmergeNested(current.data, spec.events);
    else if (spec.format === 'flat') result = unmergeFlat(current.data, spec.events);
    else result = unmergeMcp(current.data);
    summary.removed = result.removed;
    const nextText = jsonText(result.data);
    if (!opts['dry-run']) writeAtomic(configPath, nextText);
    summary.afterSha256 = opts['dry-run'] ? currentSha256 : sha256(nextText);
    summary.status = opts['dry-run'] ? 'DRY-RUN-WOULD-UNMERGE' : 'UNMERGED-WITH-DRIFT';
    summary.note = 'config changed after install; removed only HALOFLUX entries and kept unrelated changes';
    summary.diff.push(`expected afterHash ${manifest.afterSha256}`);
    summary.diff.push(`found    currentHash ${currentSha256}`);
    summary.diff.push(`removed  ${result.removed} HALOFLUX entr${result.removed === 1 ? 'y' : 'ies'}`);
  }

  if (!opts['dry-run']) {
    const updated = {
      ...manifest,
      uninstalled: true,
      uninstalledAt: new Date().toISOString(),
      uninstallResult: summary.status,
    };
    writeFileSync(path.join(found.dir, MANIFEST_NAME), jsonText(updated), 'utf8');
  }
  printSummary(summary, opts.json);
  return summary;
}

function verify(host, opts) {
  const spec = HOSTS[host];
  const configRoot = opts['config-root'] ? path.resolve(opts['config-root']) : spec.configRoot();
  const configPath = path.join(configRoot, spec.configFile);
  const current = readConfig(configPath);
  const found = findLatestManifest(opts['backup-root'] ? path.resolve(opts['backup-root']) : defaultBackupRoot(), host);
  let installed = false;
  if (current.exists) {
    if (spec.format === 'mcp') installed = Boolean(current.data?.mcpServers?.['haloflux-status']);
    else {
      const hooks = current.data?.hooks || {};
      installed = spec.events.every((event) => (hooks[event] || []).some((group) => {
        if (spec.format === 'flat') return isOurCommand(group?.command);
        const inner = Array.isArray(group?.hooks) ? group.hooks : [];
        return inner.some((hook) => isOurCommand(hook?.command));
      }));
    }
  }
  const summary = {
    action: 'verify', host, hostLabel: spec.label,
    status: installed ? 'INSTALLED' : 'NOT-INSTALLED',
    configPath,
    exists: current.exists,
    currentSha256: current.exists ? sha256(current.text) : 'MISSING',
    manifestDir: found?.dir || null,
    manifestAfterSha256: found?.manifest?.afterSha256 || null,
    matchesManifest: found ? (current.exists && sha256(current.text) === found.manifest.afterSha256) : null,
    installed,
    rollbackCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(REPO_ROOT, 'adapters', host, 'uninstall.ps1')}"`,
  };
  printSummary(summary, opts.json);
  return summary;
}

/* --------------------------------------------------------------------- main */

const isMain = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  // The first positional argument is the host (`--host` also works).
  const positional = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const host = opts.host && opts.host !== true ? opts.host : positional;
  const action = opts.action && opts.action !== true ? opts.action : 'install';

  try {
    if (opts.help) {
      process.stdout.write('usage: node installer.mjs <host> [--action install|uninstall|verify] [--config-root p] [--backup-root p] [--manifest p] [--bridge-url u] [--node p] [--mode Hooks] [--json] [--dry-run]\n');
      process.exit(0);
    }
    if (!host || !HOSTS[host]) throw new Error(`unknown or missing host: ${host || '(none)'}; expected one of ${Object.keys(HOSTS).join(', ')}`);
    if (!['install', 'uninstall', 'verify'].includes(action)) throw new Error(`unknown action: ${action}`);
    if (action === 'install') install(host, opts);
    else if (action === 'uninstall') uninstall(host, opts);
    else verify(host, opts);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[haloflux-installer] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

}
