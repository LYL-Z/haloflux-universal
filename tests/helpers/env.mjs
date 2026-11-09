/**
 * Shared paths / readiness helpers for the HALOFLUX test suite.
 *
 * Contract: docs/architecture.md §11. A suite whose module is not on disk must
 * report NOT_READY (skipped) rather than pass. A suite whose module exists but
 * misbehaves must fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (D:\HALOFLUX). */
export const ROOT = path.resolve(here, '..', '..');

export function repoPath(...parts) {
  return path.join(ROOT, ...parts);
}

export function exists(...parts) {
  return fs.existsSync(repoPath(...parts));
}

/** Import a workspace ESM file; returns null when the file does not exist yet. */
export async function importIfExists(relPath) {
  const abs = repoPath(relPath);
  if (!fs.existsSync(abs)) return null;
  return import(pathToFileURL(abs).href);
}

/** Read a JSON file if present, else null. */
export function readJsonIfExists(relPath) {
  const abs = repoPath(relPath);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/** Read a text file if present, else null. */
export function readTextIfExists(relPath) {
  const abs = repoPath(relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

/** Reason string used in `{skip}` options. */
export function notReady(reason) {
  return `NOT_READY: ${reason}`;
}

/**
 * Minimal sleep helper. Tests use polling deadlines rather than fixed sleeps
 * where possible, but SSE throttling (>= 250 ms) needs a floor.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `fn` until it returns truthy or the deadline passes. */
export async function waitFor(fn, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  return undefined;
}
