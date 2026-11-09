/**
 * Black-box harness for the real haloflux bridge (docs/architecture.md §3, §6).
 *
 * The bridge is always started as a child process, on a random port in the
 * 17910-17999 range (never the production 17817), with an isolated
 * HALOFLUX_HOME so tests never touch the user's token/settings.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ROOT, waitFor, sleep } from './env.mjs';

export const BRIDGE_ENTRY = path.join(ROOT, 'packages', 'event-bridge', 'src', 'server.mjs');

export function bridgeImplemented() {
  return fs.existsSync(BRIDGE_ENTRY);
}

/** Reserve-and-release probe for a free loopback port. */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** A random free port in the test range; never 17817. */
export async function freePort() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const port = 17910 + Math.floor(Math.random() * 90);
    if (port === 17817) continue;
    if (await portFree(port)) return port;
  }
  throw new Error('no free loopback port found in 17910-17999');
}

function tail(text, max = 4000) {
  if (!text) return '';
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * Start the real bridge. Throws a descriptive error if it does not become
 * healthy; callers should only start it when `bridgeImplemented()` is true.
 */
export async function startBridge({ port: requestedPort, token: explicitToken, env: extraEnv } = {}) {
  const port = requestedPort ?? (await freePort());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-test-'));
  const token = explicitToken ?? crypto.randomBytes(32).toString('hex');
  const childEnv = {
    ...process.env,
    HALOFLUX_BRIDGE_PORT: String(port),
    HALOFLUX_HOME: home,
    HALOFLUX_TOKEN: token,
    HALOFLUX_LOG_LEVEL: 'error',
    NO_COLOR: '1',
    ...extraEnv,
  };

  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 64 * 1024) stdout = stdout.slice(-32 * 1024);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
  });

  let exited = false;
  const exitState = { code: null, signal: null };
  child.on('exit', (code, signal) => {
    exited = true;
    exitState.code = code;
    exitState.signal = signal;
  });

  const base = `http://127.0.0.1:${port}`;
  let health;
  try {
    health = await waitFor(
      async () => {
        if (exited) {
          throw new Error(
            `bridge exited before health check (code=${exitState.code}, signal=${exitState.signal})\n` +
              `stdout: ${tail(stdout)}\nstderr: ${tail(stderr)}`,
          );
        }
        try {
          const res = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1000) });
          if (!res.ok) return undefined;
          return await res.json();
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 15000, intervalMs: 120 },
    );
  } catch (error) {
    await stopChild(child);
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }

  const handle = {
    port,
    base,
    token,
    home,
    child,
    health,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    headers() {
      return { authorization: `Bearer ${token}` };
    },
    async get(pathname) {
      const res = await fetch(`${base}${pathname}`, {
        headers: handle.headers(),
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: Object.fromEntries(res.headers), text, json };
    },
    async post(pathname, body, { headers = {}, raw = false } = {}) {
      const payload = raw ? body : JSON.stringify(body);
      const res = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: {
          ...handle.headers(),
          'content-type': 'application/json',
          ...headers,
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: Object.fromEntries(res.headers), text, json };
    },
    async state() {
      const res = await handle.get('/v1/state');
      if (res.status !== 200 || !res.json) {
        throw new Error(`GET /v1/state failed: ${res.status} ${tail(res.text, 800)}`);
      }
      return res.json;
    },
    logs() {
      return { stdout, stderr };
    },
    async stop() {
      await stopChild(child);
      // Give Windows a moment to release the token file handle, then remove.
      for (let i = 0; i < 10; i += 1) {
        try {
          fs.rmSync(home, { recursive: true, force: true });
          break;
        } catch {
          await sleep(100);
        }
      }
    },
  };

  // HALOFLUX_TOKEN is part of the contract (§3). If a bridge build ignores it,
  // fall back to the token file it wrote, so tests validate auth rather than
  // failing on token plumbing. The token actually in use is reported.
  const stateUnauthorized = await fetch(`${base}/v1/state`, {
    headers: handle.headers(),
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (stateUnauthorized && stateUnauthorized.status === 401) {
    const tokenFile = path.join(home, 'token');
    if (fs.existsSync(tokenFile)) {
      const fileToken = fs.readFileSync(tokenFile, 'utf8').trim();
      if (fileToken) {
        handle.token = fileToken;
        handle.tokenSource = 'token-file';
      }
    }
  } else if (stateUnauthorized && stateUnauthorized.status === 200) {
    handle.tokenSource = 'env';
  } else {
    handle.tokenSource = 'unknown';
  }

  return handle;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Minimal SSE client: first frame is `snapshot`, then `update`s, with `: ping`
 * comments ignored. Callers assert frames explicitly.
 */
export async function connectSse(base, token, { extraQuery = '', timeoutMs = 8000 } = {}) {
  const url = `${base}/v1/stream?token=${encodeURIComponent(token)}${extraQuery}`;
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(new Error('SSE hard timeout')), timeoutMs * 4);
  const res = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    clearTimeout(hardTimer);
    const body = await res.text().catch(() => '');
    return { res, ok: false, body, close: () => controller.abort() };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  const queue = [];
  const waiters = [];

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const parsed = parseFrame(frame);
          if (parsed) {
            if (waiters.length > 0) waiters.shift()(parsed);
            else queue.push(parsed);
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted by the test */
    } finally {
      closed = true;
      while (waiters.length > 0) waiters.shift()(undefined);
    }
  })();

  function next(waitMs = 6000) {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      }, waitMs);
      waiters.push((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
  }

  return {
    res,
    ok: true,
    next,
    get buffered() {
      return queue.length;
    },
    async close() {
      clearTimeout(hardTimer);
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      await pump.catch(() => {});
    },
  };
}

function parseFrame(frame) {
  const lines = frame.split('\n');
  let event = 'message';
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return undefined;
  const raw = data.join('\n');
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { event, raw, json };
}
