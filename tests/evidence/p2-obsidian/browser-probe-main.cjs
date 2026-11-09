#!/usr/bin/env node
/**
 * REVIEW EVIDENCE ONLY — not part of the CI suite.
 *
 * End-to-end probe for the opt-in Obsidian static snapshot import:
 * serves this repository over loopback HTTP, loads the real renderer in the
 * bundled Electron build (43.x), then drives `#lab-obsidian-file` with synthetic
 * File objects and inspects DOM / localStorage / network.
 *
 * Run (ELECTRON_RUN_AS_NODE must be unset so Electron boots as a GUI app):
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE; electron.exe tests/evidence/p2-obsidian/browser-probe-main.cjs
 *
 * Writes tests/evidence/p2-obsidian/browser-probe-result.json and exits non-zero
 * if any PASS check fails.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = process.env.HALOFLUX_OBSIDIAN_PROBE_OUT || path.join(__dirname, 'browser-probe-result.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const LOG = path.join(__dirname, 'browser-probe-run.log');
const log = (line) => {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
};
log('boot');
const USER_DATA = path.join(os.tmpdir(), `haloflux-obsidian-probe-${process.pid}`);
try {
  fs.mkdirSync(USER_DATA, { recursive: true });
  app.setPath('userData', USER_DATA);
  log(`userData=${USER_DATA}`);
} catch (error) {
  log(`setPath failed: ${error && error.message ? error.message : error}`);
}
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error && error.stack ? error.stack : error}`);
});
process.on('unhandledRejection', (error) => {
  log(`unhandledRejection: ${error && error.stack ? error.stack : error}`);
});


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* This function is serialized into the page via executeJavaScript(). Keep it
 * fully self-contained: no closure over main-process variables. */
async function pageProbe() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (id) => document.getElementById(id);
  const checks = [];
  const observations = {};
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, pass: true, detail: detail === undefined ? null : detail });
    } catch (error) {
      checks.push({ name, pass: false, detail: String((error && error.message) || error) });
    }
  };

  const toastText = () => {
    const node = $('toast');
    return node && !node.hidden ? String(node.innerText || node.textContent || '') : '';
  };
  const knowledgeText = () => String(($('lab-knowledge-details') && $('lab-knowledge-details').innerText) || '')
    .replace(/\s+/g, ' ').trim();
  const digits = (text) => text.replace(/[^0-9]/g, '');
  const importText = async (text, name) => {
    const input = $('lab-obsidian-file');
    const dt = new DataTransfer();
    dt.items.add(new File([text], name || 'obsidian-metadata.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
    return { toast: toastText(), knowledge: knowledgeText() };
  };
  const payload = (notes, links, folders, extra) => JSON.stringify(Object.assign({
    schema: 'haloflux.obsidian.metadata.v1',
    notes,
    links,
    folders,
    generatedAt: '2026-11-09T00:00:00.000Z',
  }, extra || {}));
  const padTo = (text, bytes) => text + ' '.repeat(Math.max(0, bytes - text.length));

  observations.baseline = knowledgeText();
  observations.csp = (() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return meta ? meta.getAttribute('content') : null;
  })();

  check('01 initial state is VAULT NOT CONNECTED', () => {
    if (!/NOT CONNECTED/.test(observations.baseline)) throw new Error(`unexpected baseline: ${observations.baseline}`);
  });

  // ── valid snapshot plus hostile extra fields ───────────────────────────
  const sensitive = payload(3392, 24636, 9, {
    path: '/private/vault/SECRET-PATH',
    title: 'SECRET-TITLE',
    body: 'SECRET-BODY',
    attachments: ['SECRET-ATTACH'],
    vaultName: 'SECRET-VAULT',
  });
  const valid = await importText(sensitive, 'SECRET-VAULT-NAME.json');
  observations.afterValidImport = valid.knowledge;

  check('02 valid import renders NOTES / RESOLVED LINKS / FOLDERS', () => {
    const text = digits(valid.knowledge);
    if (!text.includes('3392246369')) throw new Error(`counts not rendered: ${valid.knowledge}`);
    if (!/LOCAL JSON SNAPSHOT/.test(valid.knowledge)) throw new Error('source label missing');
    if (!/STATIC \/ NO LIVE ACCESS/.test(valid.knowledge)) throw new Error('static-mode label missing');
  });

  check('03 sensitive extra fields and the chosen file name never reach the DOM text', () => {
    const body = document.body.innerText || '';
    for (const marker of ['SECRET-PATH', 'SECRET-TITLE', 'SECRET-BODY', 'SECRET-ATTACH', 'SECRET-VAULT', 'SECRET-VAULT-NAME']) {
      if (body.includes(marker)) throw new Error(`leaked ${marker}`);
    }
  });

  check('04 imported snapshot is not written to localStorage', () => {
    const entries = Object.entries(localStorage);
    for (const [key, value] of entries) {
      const joined = `${key}=${value}`;
      if (/obsidian|SECRET|3392|24636/i.test(joined)) throw new Error(`localStorage leak: ${joined}`);
    }
  });
  observations.localStorageKeys = Object.keys(localStorage);

  check('05 file input is cleared after import (no file handle retained)', () => {
    const input = $('lab-obsidian-file');
    if (input.value !== '') throw new Error(`input.value = ${JSON.stringify(input.value)}`);
    if (input.files && input.files.length !== 0) throw new Error(`input.files.length = ${input.files.length}`);
  });

  // ── 64 KiB boundary ────────────────────────────────────────────────────
  const exact = padTo(payload(4242, 24636, 9), 65536);
  if (exact.length !== 65536) throw new Error(`bad exact fixture length ${exact.length}`);
  const exactResult = await importText(exact, 'exact-64kib.json');
  observations.afterExact64KiB = exactResult.knowledge;
  check('06 exactly 65,536-byte JSON is accepted (64 KiB cap is inclusive)', () => {
    if (!digits(exactResult.knowledge).includes('4242246369')) throw new Error(`boundary not accepted: ${exactResult.knowledge}`);
  });

  const oversize = padTo(payload(7777, 1, 1), 65537);
  if (oversize.length !== 65537) throw new Error(`bad oversize fixture length ${oversize.length}`);
  const overResult = await importText(oversize, 'too-big.json');
  observations.afterOversize = { toast: overResult.toast, knowledge: overResult.knowledge };
  check('07 65,537-byte JSON is rejected with a 64 KiB toast', () => {
    if (!/64 KiB/.test(overResult.toast)) throw new Error(`toast: ${JSON.stringify(overResult.toast)}`);
    if (digits(overResult.knowledge).includes('7777')) throw new Error('oversize file was partially imported');
  });
  observations.oversizeRetainsPreviousSnapshot = digits(overResult.knowledge).includes('4242246369');

  // ── wrong schema / bad counts ─────────────────────────────────────────
  const wrongSchema = await importText(
    JSON.stringify({ schema: 'haloflux.obsidian.metadata.v2', notes: 999999, links: 0, folders: 0 }),
    'wrong-schema.json',
  );
  check('08 wrong schema rejected with format toast', () => {
    if (!/格式不正确/.test(wrongSchema.toast)) throw new Error(`toast: ${JSON.stringify(wrongSchema.toast)}`);
    if (digits(wrongSchema.knowledge).includes('999999')) throw new Error('wrong-schema counts were imported');
  });

  for (const [label, bad] of [
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '9000'],
  ]) {
    const result = await importText(payload(bad, 0, 0), `bad-${label}.json`);
    check(`09 ${label} count rejected`, () => {
      if (!/格式不正确/.test(result.toast)) throw new Error(`toast: ${JSON.stringify(result.toast)}`);
    });
  }

  // ── prototype pollution + HTML injection payload ──────────────────────
  const polluted = '{"schema":"haloflux.obsidian.metadata.v1","notes":7,"links":8,"folders":9,'
    + '"__proto__":{"polluted":"yes","notes":999},"constructor":{"prototype":{"polluted2":"yes"}},'
    + '"title":"<img src=x onerror=window.__XSS=1>","body":"<svg onload=window.__XSS2=1>",'
    + '"html":"<script>window.__XSS3=1<\\/script>"}';
  const pollutedResult = await importText(polluted, 'proto.json');
  observations.afterPollution = { toast: pollutedResult.toast, knowledge: pollutedResult.knowledge };
  check('10 __proto__/constructor payload does not pollute or inject HTML', () => {
    if (Object.prototype.polluted !== undefined) throw new Error('Object.prototype.polluted set');
    if (Object.prototype.polluted2 !== undefined) throw new Error('Object.prototype.polluted2 set');
    if (window.__XSS !== undefined || window.__XSS2 !== undefined || window.__XSS3 !== undefined) throw new Error('inline payload executed');
    const container = $('lab-knowledge-details');
    if (!container) throw new Error('knowledge container missing');
    if (container.querySelector('img, svg, script')) throw new Error('payload element injected');
    if (/onerror|onload|<img|<svg/i.test(container.innerHTML)) throw new Error('payload markup reached innerHTML');
    if (!digits(pollutedResult.knowledge).includes('789')) throw new Error(`allowlisted counts missing: ${pollutedResult.knowledge}`);
  });

  // ── malformed / deeply nested file at the size cap ───────────────────
  const deep = '['.repeat(65536);
  const deepResult = await importText(deep, 'deep.json');
  observations.afterDeepJson = { toast: deepResult.toast, knowledge: deepResult.knowledge };
  check('11 deeply nested invalid JSON is handled without crashing the page', () => {
    if (!/无法解析|格式不正确/.test(deepResult.toast)) throw new Error(`toast: ${JSON.stringify(deepResult.toast)}`);
    if (!window.__halofluxQA || window.__halofluxQA.ready !== true) throw new Error('QA hook not ready after malformed import');
  });

  const bom = await importText(`\uFEFF${payload(5151, 0, 0)}`, 'bom.json');
  observations.afterBom = { toast: bom.toast, knowledge: bom.knowledge };
  check('12 UTF-8 BOM-prefixed JSON is accepted (File.text strips BOM; Windows-friendly)', () => {
    if (!/仅已加载/.test(bom.toast)) throw new Error(`toast: ${JSON.stringify(bom.toast)}`);
    if (!digits(bom.knowledge).includes('5151')) throw new Error(`counts not rendered: ${bom.knowledge}`);
  });

  // ── limitations / freshness observations ─────────────────────────────
  observations.clearControlPresent = !!document.querySelector('section.lab-knowledge button, section.lab-knowledge [data-clear]');
  observations.generatedAtDisplayed = /2026-11-09/.test(knowledgeText());
  observations.finalKnowledgeText = knowledgeText();
  observations.resourceOrigins = [...new Set(
    performance.getEntriesByType('resource').map((entry) => {
      try { return new URL(entry.name).origin; } catch { return 'invalid'; }
    }),
  )];

  check('13 all imported-UI state is rendered as text (no child elements added)', () => {
    const container = $('lab-knowledge-details');
    if (!container) throw new Error('knowledge container missing');
    const rows = container.querySelectorAll('.lab-detail');
    if (rows.length !== 5) throw new Error(`expected 5 detail rows, got ${rows.length}`);
    for (const row of rows) {
      if (row.children.length !== 2) throw new Error('detail row structure changed');
    }
  });

  check('14 CSP restricts connect-src to loopback only', () => {
    const csp = observations.csp || '';
    const match = csp.match(/connect-src([^;]*)/);
    if (!match) throw new Error(`no connect-src in CSP: ${csp}`);
    const hosts = match[1].trim().split(/\s+/).filter(Boolean);
    const allowed = ['http://127.0.0.1:*', 'http://localhost:*'];
    if (hosts.length !== allowed.length || !allowed.every((entry) => hosts.includes(entry))) {
      throw new Error(`unexpected connect-src hosts: ${hosts.join(' ')}`);
    }
  });

  return { checks, observations };
}

app.whenReady().then(async () => {
  let server = null;
  const requests = [];
  const consoleErrors = [];
  const consoleMessages = [];
  const consoleLeaks = [];
  let result = null;
  let fatal = null;
  let origin = '';
  let url = '';
  try {
    log('ready');
    server = await startServer();
    const port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
    url = `${origin}/apps/companion/renderer/index.html?demo=1&qa=1`;
    log(`serving ${url}`);

    const win = new BrowserWindow({
      width: 1600,
      height: 900,
      show: false,
      frame: false,
      backgroundColor: '#06080b',
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      requests.push(details.url);
      callback({});
    });
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message);
      consoleMessages.push({ level, message: text });
      if (level >= 2) consoleErrors.push(text);
      if (/SECRET|obsidian|3,?392|24,?636/i.test(text)) consoleLeaks.push(text);
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      consoleErrors.push(`did-fail-load ${code} ${description}`);
    });
    await win.loadURL(url);
    log('loaded');
    await sleep(1500);
    log('probe start');
    result = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`, true);
    log(`probe done checks=${result && result.checks ? result.checks.length : 'none'}`);
    win.destroy();
  } catch (error) {
    fatal = String((error && error.message) || error);
    log(`fatal ${fatal}`);
  }

  if (server) server.close();
  const offOrigin = requests.filter((requestUrl) => !requestUrl.startsWith(origin));
  const bridgeHits = requests.filter((requestUrl) => requestUrl.includes('17817'));
  const checks = result ? result.checks : [];
  const failed = checks.filter((entry) => !entry.pass);
  const ok = !fatal && failed.length === 0 && offOrigin.length === 0 && bridgeHits.length === 0 && consoleLeaks.length === 0;
  const record = {
    schema: 'haloflux.review.obsidian-browser-probe.v1',
    generatedAt: new Date().toISOString(),
    target: { url, origin, repo: ROOT, electron: process.versions.electron, node: process.versions.node },
    fatal,
    checks,
    observations: result ? result.observations : null,
    network: {
      requestCount: requests.length,
      offOrigin,
      bridgeHits,
      urls: [...new Set(requests)],
    },
    consoleErrors,
    consoleMessages,
    consoleLeaks,
    summary: { pass: checks.length - failed.length, fail: failed.length, ok },
  };
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
    log(`result ${OUT} ok=${ok}`);
  } catch (error) {
    log(`result write failed: ${error && error.message ? error.message : error}`);
  }
  console.log(JSON.stringify({ out: OUT, fatal, summary: record.summary, offOrigin, bridgeHits, consoleErrors, consoleLeaks }));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  log(`whenReady failed: ${error && error.stack ? error.stack : error}`);
  app.exit(1);
});

setTimeout(() => {
  console.error('obsidian browser probe timeout');
  app.exit(3);
}, 90000);
