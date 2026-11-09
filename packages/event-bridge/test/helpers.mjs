/**
 * Shared helpers for the event-bridge tests. Every server binds port 0 so the
 * real 17817 bridge is never touched.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createEvent } from '../../event-schema/dist/index.js';
import { createBridgeServer } from '../src/server.mjs';

export const TEST_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

export function makeTempHome(prefix = 'haloflux-bridge-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeEvent(overrides = {}) {
  return createEvent({
    host: 'claude-code',
    hostVersion: '2.1.299',
    sessionId: 'claude-code:test-session',
    eventType: 'run.start',
    ...overrides,
  });
}

export function uniqueEventId(seq = 0) {
  return `test-event-${String(seq).padStart(6, '0')}`;
}

/**
 * Start an isolated bridge on an OS-assigned port.
 * @returns {Promise<{bridge: object, home: string, url: string, port: number, token: string, close: () => Promise<void>}>}
 */
export async function startBridge(overrides = {}) {
  const ownedHome = !overrides.home;
  const home = overrides.home || makeTempHome();
  const token = overrides.token || TEST_TOKEN;
  const bridge = createBridgeServer({
    home,
    token,
    port: 0,
    logLevel: 'silent',
    ...overrides,
    token: overrides.token || TEST_TOKEN,
  });
  let info;
  try {
    info = await bridge.start();
  } catch (error) {
    if (ownedHome) fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const close = async () => {
    await bridge.stop();
    if (ownedHome) fs.rmSync(home, { recursive: true, force: true });
  };
  return { bridge, home, url: info.url, port: info.port, token, close };
}

export async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

export function authHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Incremental SSE frame reader over a fetch Response body. */
export function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    cancel() {
      try {
        reader.cancel();
      } catch {
        /* already closed */
      }
    },
    async nextFrame(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const frame = { event: null, data: null, comments: [] };
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith(':')) frame.comments.push(line.slice(1).trim());
            else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              const value = line.slice(5).trim();
              try {
                frame.data = JSON.parse(value);
              } catch {
                frame.data = value;
              }
            }
          }
          if (frame.event) return frame;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('SSE frame timeout');
        const read = await withTimeout(reader.read(), remaining, 'SSE read');
        if (read.done) throw new Error('SSE stream ended before a frame arrived');
        buffer += decoder.decode(read.value, { stream: true });
      }
    },
  };
}

/** Raw HTTP request helper (lets tests control Host header + keep-alive). */
export function rawRequest(url, { method = 'GET', headers = {}, body = null, agent = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, agent }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}
