/**
 * HALOFLUX — read-only file watcher helper shared by the derived adapters.
 *
 * Some hosts expose no passive hook API. For those, an adapter may *tail* a
 * host-owned log file and derive events. Contract §4 requires such events to be
 * downgraded: `source: 'derived'`, `confidence: 'inferred'`. The UI renders a
 * "推断" badge, so the user always knows the difference.
 *
 * Guarantees:
 *  - read-only: files are only opened with `r`, never written, moved or locked;
 *  - bounded: at most `MAX_READ_BYTES` per tick, so a 38 MB rollout file does
 *    not stall a host;
 *  - never throws: a missing/rotating file just yields no events;
 *  - state is persisted to `adapters/_shared/.watch-state/<host>.json` so a
 *    restart does not replay the whole history.
 */
import {
  existsSync, readFileSync, statSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;

export function statePathFor(host) {
  return path.join(here, '.watch-state', `${host}.json`);
}

export function readState(host) {
  try {
    const file = statePathFor(host);
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeState(host, state) {
  try {
    mkdirSync(path.dirname(statePathFor(host)), { recursive: true });
    writeFileSync(statePathFor(host), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    /* watching must never throw */
  }
}

/** Recursively collect files under `root` matching `match`, bounded depth. */
export function listFiles(root, { match = () => true, maxDepth = 6 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && match(full, entry.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Read bytes appended to `file` since `offset`, split into complete lines.
 * A trailing partial line is left for the next tick, unless `flush` is set
 * (single-shot runs must not lose a final line that has no trailing newline).
 * @returns {{lines: string[], offset: number}}
 */
export function readFromOffset(file, offset, maxBytes = MAX_READ_BYTES, flush = false) {
  let size = 0;
  try { size = statSync(file).size; } catch { return { lines: [], offset }; }
  const start = Math.max(0, Math.min(offset, size));
  if (start >= size) return { lines: [], offset: start };
  const length = Math.min(size - start, maxBytes);
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, start);
  } catch {
    return { lines: [], offset: start };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const endsWithNewline = /\r?\n$/.test(text);
  const parts = text.split(/\r?\n/);
  const lines = endsWithNewline
    ? parts.filter((line) => line.trim() !== '')
    : (flush ? parts.filter((line) => line.trim() !== '') : parts.slice(0, -1).filter((line) => line.trim() !== ''));
  const consumed = endsWithNewline || flush
    ? length
    : Math.max(0, length - Buffer.byteLength(parts[parts.length - 1] || ''));
  return { lines, offset: start + consumed };
}

/** Pick the newest file (by mtime) from a candidate list. */
export function newestFile(files) {
  let best;
  let bestMtime = -1;
  for (const file of files) {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime > bestMtime) { bestMtime = mtime; best = file; }
    } catch {
      /* skip vanished file */
    }
  }
  return best;
}

/**
 * One watcher tick: read new lines of the newest matching file.
 * First sight of a file starts at `size - tailBytes` (0 = replay it all).
 * @returns {{file: string|undefined, lines: string[], state: object}}
 */
export function poll({ host, files, initialState, write = true, tailBytes = DEFAULT_TAIL_BYTES, flush = false }) {
  const state = { ...(initialState ?? readState(host)) };
  const file = newestFile(files);
  if (!file) return { file: undefined, lines: [], state };
  if (state.file !== file) {
    let size = 0;
    try { size = statSync(file).size; } catch { /* ignore */ }
    state.file = file;
    // tailBytes 0 (or negative) means "replay from the beginning"; a positive
    // value skips the existing history and only follows new lines.
    state.offset = tailBytes > 0 ? Math.max(0, size - tailBytes) : 0;
  }
  const { lines, offset } = readFromOffset(file, Number(state.offset) || 0, MAX_READ_BYTES, flush);
  state.offset = offset;
  state.updatedAt = new Date().toISOString();
  if (write) writeState(host, state);
  return { file, lines, state };
}

/**
 * Timer-driven watcher loop. `onLines(lines, file)` may be async.
 * With `once: true` it performs a single tick and returns (used by tests and by
 * `doctor.ps1`).
 */
export async function runWatchLoop({
  host, files, onLines, once = false, intervalMs = 1000, tailBytes = DEFAULT_TAIL_BYTES, maxTicks,
}) {
  const state = readState(host);
  let ticks = 0;
  const tick = async () => {
    // A single-shot run flushes the last unterminated line; a live watcher waits
    // for the host to finish writing it.
    const result = poll({ host, files: files(), initialState: state, tailBytes, flush: once });
    state.file = result.state.file;
    state.offset = result.state.offset;
    if (result.lines.length) await onLines(result.lines, result.file);
  };
  await tick();
  ticks += 1;
  if (once) return;
  for (;;) {
    if (maxTicks && ticks >= maxTicks) return;
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, intervalMs)));
    try { await tick(); } catch { /* keep watching */ }
    ticks += 1;
  }
}
