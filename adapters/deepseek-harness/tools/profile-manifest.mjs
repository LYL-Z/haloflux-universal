#!/usr/bin/env node
/**
 * Profile manifest editor for the HALOFLUX DSH integration.
 *
 * The DSH profile manifest is `package.json`:
 *   - `dependencies` must resolve the bundle package for the Host loader;
 *   - `dsh.profile.bundles` is the ordered bundle layer list.
 *
 * This helper edits only those two locations, atomically, and never touches
 * `cordis.patch.yml` (the user overlay layer).
 *
 *   node profile-manifest.mjs add    <profileDir> <bundleName> <spec>
 *   node profile-manifest.mjs remove <profileDir> <bundleName>
 *   node profile-manifest.mjs list   <profileDir>
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function die(message) {
  console.error(`profile-manifest: ${message}`);
  process.exit(1);
}

async function readManifest(profileDir) {
  const file = join(profileDir, 'package.json');
  if (!existsSync(file)) die(`missing ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    die(`invalid JSON in ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') die(`${file} is not a JSON object`);
  if (!parsed.dsh || typeof parsed.dsh !== 'object') parsed.dsh = {};
  if (!parsed.dsh.profile || typeof parsed.dsh.profile !== 'object') parsed.dsh.profile = {};
  if (!Array.isArray(parsed.dsh.profile.bundles)) parsed.dsh.profile.bundles = [];
  if (!parsed.dependencies || typeof parsed.dependencies !== 'object') parsed.dependencies = {};
  return { file, manifest: parsed };
}

async function writeManifest(file, manifest) {
  const temp = `${file}.haloflux-${process.pid}.tmp`;
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
  return Buffer.byteLength(text);
}

async function add(profileDir, bundleName, spec) {
  const { file, manifest } = await readManifest(profileDir);
  const before = new Set(manifest.dsh.profile.bundles);
  manifest.dependencies[bundleName] = spec;
  if (!before.has(bundleName)) manifest.dsh.profile.bundles.push(bundleName);
  const bytes = await writeManifest(file, manifest);
  return {
    ok: true,
    action: 'add',
    file,
    bundleName,
    alreadyListed: before.has(bundleName),
    bundles: manifest.dsh.profile.bundles,
    bytes,
  };
}

async function remove(profileDir, bundleName) {
  const { file, manifest } = await readManifest(profileDir);
  const hadDependency = Object.prototype.hasOwnProperty.call(manifest.dependencies, bundleName);
  const before = manifest.dsh.profile.bundles.length;
  delete manifest.dependencies[bundleName];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((entry) => entry !== bundleName);
  const bytes = await writeManifest(file, manifest);
  return {
    ok: true,
    action: 'remove',
    file,
    bundleName,
    removedDependency: hadDependency,
    removedFromBundles: before - manifest.dsh.profile.bundles.length,
    bundles: manifest.dsh.profile.bundles,
    bytes,
  };
}

async function list(profileDir) {
  const { manifest } = await readManifest(profileDir);
  return {
    ok: true,
    action: 'list',
    bundles: manifest.dsh.profile.bundles,
    dependencies: Object.keys(manifest.dependencies).filter((name) => /haloflux/i.test(name)),
  };
}

const [action, ...rest] = process.argv.slice(2);
if (action === 'add') {
  const [profileDir, bundleName, spec] = rest;
  if (!profileDir || !bundleName || !spec) die('usage: add <profileDir> <bundleName> <spec>');
  add(resolve(profileDir), bundleName, spec).then((out) => console.log(JSON.stringify(out))).catch((error) => die(error.message));
} else if (action === 'remove') {
  const [profileDir, bundleName] = rest;
  if (!profileDir || !bundleName) die('usage: remove <profileDir> <bundleName>');
  remove(resolve(profileDir), bundleName).then((out) => console.log(JSON.stringify(out))).catch((error) => die(error.message));
} else if (action === 'list') {
  const [profileDir] = rest;
  if (!profileDir) die('usage: list <profileDir>');
  list(resolve(profileDir)).then((out) => console.log(JSON.stringify(out))).catch((error) => die(error.message));
} else {
  die('usage: <add|remove|list> …');
}
