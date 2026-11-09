/**
 * HALOFLUX — adapter doctor.
 *
 * Read-only status report used by `scripts/doctor.ps1` (and by QA). It answers
 * the five questions the task asks for:
 *   1. is the adapter installed in the host config?
 *   2. is the bridge token readable?
 *   3. is the loopback bridge online?
 *   4. does the host config still match the install manifest (drift)?
 *   5. what is the exact rollback command?
 *
 * Exit code is 0 whenever the report could be produced; a missing adapter or an
 * offline bridge is reported as data, not as a command failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  bridgeHealth, readToken, resolveTokenPath, resolveBridgeUrl, readHostVersion, resolveHalofluxHome,
} from './event-client.mjs';
import { findLatestManifest } from './installer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const DEFAULT_BACKUP_ROOT = path.join(REPO_ROOT, 'config', 'backups');

const HOSTS = {
  'claude-code': { label: 'Claude Code', root: () => path.join(homedir(), '.claude'), file: 'settings.json', format: 'nested' },
  codex: { label: 'Codex', root: () => path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex')), file: 'hooks.json', format: 'nested' },
  cursor: { label: 'Cursor', root: () => path.join(homedir(), '.cursor'), file: 'hooks.json', format: 'flat' },
  trae: { label: 'TRAE CN', root: () => path.join(homedir(), '.trae-cn'), file: 'hooks.json', format: 'flat' },
  workbuddy: { label: 'WorkBuddy', root: () => path.join(homedir(), '.workbuddy'), file: 'mcp.json', format: 'mcp' },
  generic: { label: 'Generic (stdin JSONL)', root: () => REPO_ROOT, file: null, format: 'none' },
};

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const argValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};
const backupRoot = argValue('backup-root', process.env.HALOFLUX_BACKUP_ROOT || DEFAULT_BACKUP_ROOT);
const configRootOverride = argValue('config-root', '');
const hostFilter = argValue('hosts', '').split(',').map((h) => h.trim()).filter(Boolean);
const token = readToken();
const tokenPath = resolveTokenPath();
const bridgeUrl = resolveBridgeUrl();

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function countOurEntries(data, format) {
  if (!data || typeof data !== 'object') return { count: 0, events: [] };
  let count = 0;
  const events = [];
  if (format === 'mcp') {
    if (data.mcpServers && data.mcpServers['haloflux-status']) return { count: 1, events: ['mcpServers.haloflux-status'] };
    return { count: 0, events: [] };
  }
  const hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let found = 0;
    for (const group of groups) {
      const commands = format === 'flat'
        ? [group && group.command]
        : (Array.isArray(group && group.hooks) ? group.hooks.map((hook) => hook && hook.command) : []);
      if (commands.some((command) => typeof command === 'string' && command.toLowerCase().includes('haloflux'))) found += 1;
    }
    if (found > 0) { count += found; events.push(event); }
  }
  return { count, events };
}

const health = await bridgeHealth({ timeoutMs: 800 });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  halofluxHome: resolveHalofluxHome(),
  bridge: { url: bridgeUrl, online: health.online, version: health.version ?? null },
  token: { path: tokenPath, fileExists: existsSync(tokenPath), readable: Boolean(token) },
  backupRoot,
  hosts: [],
};

for (const [host, spec] of Object.entries(HOSTS)) {
  if (hostFilter.length > 0 && !hostFilter.includes(host)) continue;
  const configRoot = configRootOverride && (hostFilter.length <= 1) ? path.resolve(configRootOverride) : spec.root();
  const configPath = spec.file ? path.join(configRoot, spec.file) : null;
  const entry = {
    host,
    label: spec.label,
    configRoot,
    configPath,
    configExists: configPath ? existsSync(configPath) : false,
    installedEntries: 0,
    installedEvents: [],
    capabilitiesFile: existsSync(path.join(REPO_ROOT, 'adapters', host, 'capabilities.json')),
    adapterFile: existsSync(path.join(REPO_ROOT, 'adapters', host, 'adapter.mjs'))
      || existsSync(path.join(REPO_ROOT, 'adapters', host, 'mcp-server.mjs')),
    hostVersion: readHostVersion(host) || '',
    manifestDir: null,
    manifestAfterSha256: null,
    currentSha256: null,
    matchesManifest: null,
    status: 'NOT-INSTALLED',
    rollbackCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(REPO_ROOT, 'adapters', host, 'uninstall.ps1')}"`,
  };

  if (configPath && entry.configExists) {
    try {
      const text = readFileSync(configPath, 'utf8');
      entry.currentSha256 = sha256(text);
      const data = JSON.parse(text.replace(/^\uFEFF/, ''));
      const found = countOurEntries(data, spec.format);
      entry.installedEntries = found.count;
      entry.installedEvents = found.events;
    } catch (error) {
      entry.status = 'CONFIG-PARSE-ERROR';
      entry.parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const found = findLatestManifest(backupRoot, host);
  if (found) {
    entry.manifestDir = found.dir;
    entry.manifestAfterSha256 = found.manifest.afterSha256;
    entry.manifestCreatedFile = Boolean(found.manifest.createdFile);
    entry.matchesManifest = entry.currentSha256 === found.manifest.afterSha256;
  }

  if (entry.status !== 'CONFIG-PARSE-ERROR') {
    if (entry.installedEntries > 0) {
      entry.status = entry.matchesManifest === false ? 'INSTALLED-DRIFTED' : 'INSTALLED';
    } else if (host === 'trae') {
      entry.status = 'UNSUPPORTED';
    } else if (host === 'generic') {
      entry.status = 'NO-INSTALL-NEEDED';
    } else {
      entry.status = 'NOT-INSTALLED';
    }
  }
  report.hosts.push(entry);
}

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [];
  lines.push(`HALOFLUX doctor  ${report.generatedAt}`);
  lines.push(`  bridge : ${report.bridge.online ? `ONLINE ${report.bridge.url}${report.bridge.version ? ` (v${report.bridge.version})` : ''}` : `OFFLINE ${report.bridge.url}`}`);
  lines.push(`  token  : ${report.token.readable ? 'READABLE' : 'MISSING'} ${report.token.path}`);
  lines.push(`  backups: ${report.backupRoot}`);
  lines.push('');
  lines.push('  host          status              entries  sha-match  config');
  for (const host of report.hosts) {
    const sha = host.matchesManifest === null ? '-' : host.matchesManifest ? 'yes' : 'DRIFT';
    lines.push(`  ${host.host.padEnd(13)} ${String(host.status).padEnd(19)} ${String(host.installedEntries).padEnd(8)} ${sha.padEnd(10)} ${host.configPath || '-'}`);
    if (host.status === 'INSTALLED-DRIFTED') lines.push(`     rollback: ${host.rollbackCommand}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
process.exit(0);
