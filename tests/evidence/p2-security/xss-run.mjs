#!/usr/bin/env node
/**
 * XSS end-to-end orchestrator (P2 security gate).
 *
 * 1. Starts the real bridge on an isolated 180xx port with a throwaway
 *    HALOFLUX_HOME + explicit token.
 * 2. POSTs a schema-valid event whose toolName is an HTML/JS payload, then
 *    proves /v1/state echoes it verbatim (the ingress really happens).
 * 3. Launches the real renderer in Electron with ?bridge/&token and runs the
 *    DOM inspection task from electron-probe.cjs.
 * 4. Stops the bridge and writes one evidence JSON: xss-e2e.json
 *
 * Exit 0 = payload rendered as text only (no element/handler/flag), 1 otherwise.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BRIDGE_ENTRY = path.join(ROOT, 'packages', 'event-bridge', 'src', 'server.mjs');
const PROBE = path.join(HERE, 'electron-probe.cjs');
const OUT = path.join(HERE, 'xss-e2e.json');
const RENDERER = path.join(ROOT, 'apps', 'companion', 'renderer', 'index.html');
const ELECTRON = process.env.HALOFLUX_ELECTRON || 'C:\\Users\\Lenovo\\.dsh\\electron\\electron.exe';
const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const token = 'f00dcafe'.repeat(8);

const importFile = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
const { createEvent } = await importFile('packages/event-schema/dist/index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  for (let i = 0; i < 200; i += 1) {
    const port = 18010 + Math.floor(Math.random() * 90);
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port');
}

function request(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
        agent: false,
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-p2xss-'));
  const env = { ...process.env, HALOFLUX_BRIDGE_PORT: String(port), HALOFLUX_HOME: home, HALOFLUX_TOKEN: token, HALOFLUX_LOG_LEVEL: 'error', NO_COLOR: '1' };
  const bridge = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let bridgeLog = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stderr.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    bridgeLog += chunk;
  });
  bridge.stderr.on('data', (chunk) => {
    bridgeLog += chunk;
  });
  const evidence = {
    schema: 'haloflux.p2.security.xss.v1',
    generatedAt: new Date().toISOString(),
    payload: PAYLOAD,
    bridge: { port, home, pid: bridge.pid },
    exitCode: null,
  };
  try {
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await request(port, 'GET', '/v1/health');
        if (res.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        /* not up */
      }
      await sleep(120);
    }
    if (!healthy) throw new Error(`bridge did not become healthy\n${bridgeLog}`);

    const event = createEvent({
      host: 'deepseek-harness',
      sessionId: 'sess-xss-probe',
      eventType: 'tool.start',
      hostVersion: 'p2-xss-1.0',
      timestamp: Date.now(),
      eventId: 'evt-xss-dom-0001',
      metadata: { toolName: PAYLOAD },
    });
    const post = await request(port, 'POST', '/v1/events', {
      body: JSON.stringify({ events: [event] }),
      headers: { authorization: `Bearer ${token}` },
    });
    const state = await request(port, 'GET', '/v1/state', { headers: { authorization: `Bearer ${token}` } });
    const session = JSON.parse(state.body).sessions.find((entry) => entry.sessionId === 'sess-xss-probe');
    evidence.ingress = {
      postStatus: post.status,
      postBody: JSON.parse(post.body),
      stateStatus: state.status,
      echoedVerbatimInState: Boolean(session && session.recentEvents.some((entry) => entry.toolName === PAYLOAD)),
      echoedToolName: session && session.recentEvents.length > 0 ? session.recentEvents[session.recentEvents.length - 1].toolName : null,
    };

    const query = `?bridge=${encodeURIComponent(`http://127.0.0.1:${port}`)}&token=${encodeURIComponent(token)}&mode=window`;
    const childEnv = { ...process.env, HALOFLUX_PROBE_TASK: 'xss', HALOFLUX_PROBE_URL: `${pathToFileURL(RENDERER).href}${query}`, HALOFLUX_PROBE_OUT: path.join(HERE, 'xss-dom.json') };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const electron = spawn(ELECTRON, [PROBE], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let electronLog = '';
    electron.stdout.setEncoding('utf8');
    electron.stderr.setEncoding('utf8');
    electron.stdout.on('data', (chunk) => {
      electronLog += chunk;
    });
    electron.stderr.on('data', (chunk) => {
      electronLog += chunk;
    });
    const electronCode = await new Promise((resolve) => {
      electron.once('exit', (code) => resolve(code));
      setTimeout(() => {
        try {
          electron.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve('timeout');
      }, 90000);
    });
    evidence.electron = { exitCode: electronCode, log: electronLog.split(/\r?\n/).filter(Boolean).slice(-12) };
    const domPath = path.join(HERE, 'xss-dom.json');
    evidence.dom = fs.existsSync(domPath) ? JSON.parse(fs.readFileSync(domPath, 'utf8')) : null;
    evidence.verdict = evidence.dom && evidence.dom.xss && evidence.dom.xss.verdict === 'PASS' ? 'PASS' : 'FAIL';
    evidence.problems = (evidence.dom && evidence.dom.xss && evidence.dom.xss.problems) || ['no DOM result'];
    evidence.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.fatal = String(error && error.stack ? error.stack : error);
    evidence.verdict = 'FAIL';
    evidence.exitCode = 2;
  } finally {
    try {
      bridge.kill();
    } catch {
      /* gone */
    }
    fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`[xss] verdict=${evidence.verdict} evidence=${OUT}`);
    if (evidence.ingress) {
      console.log(`[xss] post=${evidence.ingress.postStatus} echoedVerbatim=${evidence.ingress.echoedVerbatimInState}`);
    }
    if (evidence.dom && evidence.dom.xss) {
      console.log(
        `[xss] rows=${evidence.dom.xss.rows} injectedElements=${evidence.dom.xss.injectedElementCount} handlers=${evidence.dom.xss.inlineHandlers.length} literalText=${evidence.dom.xss.feedTextContainsLiteralImg} flags=${JSON.stringify(evidence.dom.xss.xssFlags)}`,
      );
    }
    if (evidence.problems) console.log(`[xss] problems=${JSON.stringify(evidence.problems)}`);
    process.exit(evidence.exitCode);
  }
}

main().catch((error) => {
  console.error('[xss] harness error:', error);
  process.exit(2);
});
