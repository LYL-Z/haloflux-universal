#!/usr/bin/env node
/**
 * Snapshot the exact working-tree files the P2 security/a11y/perf evidence was
 * measured against (shared workspace: other agents may edit concurrently).
 *
 * Usage: node tests/evidence/p2-security/worktree-hashes.mjs <label>
 *   labels are appended to one JSON; "post" also diffs against the first label.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const label = process.argv[2] || 'snapshot';
const OUT = path.join(HERE, 'worktree-hashes.json');

const FILES = [
  'apps/companion/renderer/app.js',
  'apps/companion/renderer/styles.css',
  'apps/companion/renderer/index.html',
  'apps/companion/renderer/monitor-projection.mjs',
  'apps/companion/renderer/obsidian-metadata.mjs',
  'apps/companion/main/main.js',
  'packages/visual-core/src/presets.js',
  'packages/visual-core/src/index.js',
  'packages/event-bridge/src/server.mjs',
  'packages/event-bridge/src/token.mjs',
  'packages/session-manager/src/index.mjs',
  'packages/event-schema/dist/index.js',
];

const files = {};
for (const relative of FILES) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) {
    files[relative] = { missing: true };
    continue;
  }
  const buffer = fs.readFileSync(absolute);
  const stat = fs.statSync(absolute);
  files[relative] = {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    return `git ${args.join(' ')} failed: ${error && error.message ? error.message : error}`;
  }
};

const snapshot = {
  label,
  generatedAt: new Date().toISOString(),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  head: git(['rev-parse', 'HEAD']),
  modifiedTracked: git(['diff', '--name-only'])
    .split(/\r?\n/)
    .filter(Boolean),
  files,
};

const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { schema: 'haloflux.p2.worktree.v1', snapshots: [] };
const snapshots = Array.isArray(existing.snapshots) ? existing.snapshots : [];
const index = snapshots.findIndex((entry) => entry.label === label);
if (index >= 0) snapshots[index] = snapshot;
else snapshots.push(snapshot);

let changedDuringMeasurement = null;
if (label === 'post' && snapshots.length > 1) {
  const baseline = snapshots[0];
  changedDuringMeasurement = [];
  for (const [file, info] of Object.entries(files)) {
    const before = baseline.files ? baseline.files[file] : undefined;
    if (!before || !before.sha256 || before.sha256 !== info.sha256) changedDuringMeasurement.push(file);
  }
}

fs.writeFileSync(OUT, `${JSON.stringify({ schema: 'haloflux.p2.worktree.v1', snapshots, changedDuringMeasurement }, null, 2)}\n`, 'utf8');
console.log(`[worktree] ${label}: head=${snapshot.head.slice(0, 7)} ${snapshot.branch} modified=${snapshot.modifiedTracked.length}`);
if (changedDuringMeasurement) {
  console.log(`[worktree] changed during measurement: ${changedDuringMeasurement.length === 0 ? 'none' : changedDuringMeasurement.join(', ')}`);
}
