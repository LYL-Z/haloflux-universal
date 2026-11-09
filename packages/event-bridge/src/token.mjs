/**
 * HALOFLUX token handling — generate/read the bridge token, constant-time compare.
 *
 * Contract: docs/architecture.md §3 + §10.
 *  - 32 random bytes, lowercase hex (64 chars);
 *  - file `$HALOFLUX_HOME/token` (default `%LOCALAPPDATA%\\HALOFLUX\\token`), mode 0600;
 *  - `HALOFLUX_TOKEN` overrides the file (tests / adapters);
 *  - the token is never logged. Use `maskToken()` if an identifier is needed.
 */

import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_BYTES = 32;
export const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
export const TOKEN_HEX_RE = /^[0-9a-f]{64}$/i;
const REDACTED = '[redacted]';

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

/** Token file path: $HALOFLUX_TOKEN_FILE or $HALOFLUX_HOME/token. */
export function tokenPath(env = process.env) {
  if (env.HALOFLUX_TOKEN_FILE && String(env.HALOFLUX_TOKEN_FILE).trim()) {
    return path.resolve(String(env.HALOFLUX_TOKEN_FILE));
  }
  return path.join(halofluxHome(env), 'token');
}

/** 32 random bytes as lowercase hex. */
export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Read a token file, returning null when missing/invalid. Never logs content. */
export function readTokenFile(file = tokenPath()) {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return TOKEN_HEX_RE.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective token: `env.HALOFLUX_TOKEN` first, then the token file.
 * @returns {string|null}
 */
export function readToken({ env = process.env, file = tokenPath(env) } = {}) {
  if (env.HALOFLUX_TOKEN && String(env.HALOFLUX_TOKEN).trim()) {
    return String(env.HALOFLUX_TOKEN).trim();
  }
  return readTokenFile(file);
}

/**
 * Ensure a token exists. Creates the token file (0600, atomic write) on first
 * start. An explicit env token is used as-is and never written to disk.
 *
 * @returns {{token: string, source: 'env'|'file'|'generated', path: string, created: boolean}}
 */
export function ensureToken({ env = process.env, file = tokenPath(env), create = true } = {}) {
  if (env.HALOFLUX_TOKEN && String(env.HALOFLUX_TOKEN).trim()) {
    return { token: String(env.HALOFLUX_TOKEN).trim(), source: 'env', path: file, created: false };
  }
  const existing = readTokenFile(file);
  if (existing) return { token: existing, source: 'file', path: file, created: false };
  if (!create) return { token: '', source: 'file', path: file, created: false };
  const token = generateToken();
  writeTokenFile(file, token);
  return { token, source: 'generated', path: file, created: true };
}

/** Atomically write a token file (tmp in the same directory + fsync + rename). */
export function writeTokenFile(file, token) {
  if (!TOKEN_HEX_RE.test(String(token))) throw new TypeError('token must be 64 hex characters');
  const directory = path.dirname(path.resolve(file));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.token.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  let fd;
  try {
    fd = openSync(tempPath, 'w', 0o600);
    writeFileSync(fd, `${token}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      /* Windows maps chmod to the read-only bit; best effort per contract. */
    }
    renameSync(tempPath, file);
    try {
      chmodSync(file, 0o600);
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

/**
 * Constant-time string comparison. Both sides are SHA-256 digested first so the
 * comparison time does not depend on token length either.
 */
export function timingSafeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) {
    return false;
  }
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return nodeTimingSafeEqual(a, b);
}

/** Safe log identifier for a token: never the token itself. */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '(none)';
  const digest = createHash('sha256').update(token).digest('hex');
  return `token:sha256:${digest.slice(0, 8)}…(${token.length} chars)`;
}

/** Remove any known secret and any 64-hex sequence from a log/error string. */
export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  return out.replace(/[0-9a-f]{64}/gi, REDACTED);
}
