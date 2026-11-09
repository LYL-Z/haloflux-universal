/**
 * Electron probe for the P2 gate: XSS DOM check, accessibility audit and
 * visible-window fps sampling against the real companion renderer.
 *
 * This is a standalone main script (NOT the production main) so the real window
 * manager/tray stays untouched. The renderer URL is passed in the environment
 * because Electron 43.3.0 exits early when argv carries a file:// URL.
 *
 * Env:
 *   HALOFLUX_PROBE_TASK   xss | a11y | fps          (default a11y)
 *   HALOFLUX_PROBE_URL    file:///.../index.html?...
 *   HALOFLUX_PROBE_OUT    JSON output path
 *   HALOFLUX_PROBE_MS     duration for the fps task (default 12000)
 *   HALOFLUX_PROBE_GPU    "0" disables hardware acceleration (default GPU on)
 *   HALOFLUX_PROBE_REDUCE "1" forces prefers-reduced-motion: reduce
 *   HALOFLUX_PROBE_SHOT   optional PNG path for a screenshot
 *
 * Web preferences mirror the production window (contextIsolation on,
 * nodeIntegration off, sandbox off — docs/03 §6 known trade-off), with no
 * preload; the bridge URL/token therefore travel in the renderer query string
 * exactly as app.js supports.
 */
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const TASK = process.env.HALOFLUX_PROBE_TASK || 'a11y';
const URL = process.env.HALOFLUX_PROBE_URL || '';
const OUT = process.env.HALOFLUX_PROBE_OUT || path.join(__dirname, 'electron-probe.json');
const DURATION = Number(process.env.HALOFLUX_PROBE_MS || '12000');
const REDUCE = process.env.HALOFLUX_PROBE_REDUCE === '1';
const SHOT = process.env.HALOFLUX_PROBE_SHOT || '';
const GPU = process.env.HALOFLUX_PROBE_GPU !== '0';
const OPEN_DRAWER = process.env.HALOFLUX_PROBE_OPEN_DRAWER === '1';

if (!GPU) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
if (REDUCE) app.commandLine.appendSwitch('force-prefers-reduced-motion');
app.commandLine.appendSwitch('no-first-run');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[probe]', ...args);

/* ------------------------------------------------------------------ *
 * page-side functions (serialized into the renderer)
 * ------------------------------------------------------------------ */

function pageReadyState() {
  const lab = document.getElementById('lab-console');
  const rows = document.querySelectorAll('#lab-feed-rows .lab-feed-row');
  return {
    href: location.href.replace(/token=[0-9a-f]+/i, 'token=<redacted>'),
    mode: document.body.dataset.mode || null,
    preset: document.body.dataset.preset || null,
    labConsoleDisplay: lab ? getComputedStyle(lab).display : null,
    labRows: rows.length,
    sessionCountText: document.getElementById('session-count')?.textContent ?? null,
    feedStatus: document.getElementById('lab-feed-status')?.textContent ?? null,
    inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
  };
}

/* ---- XSS: event metadata must render as text, never as markup ---- */
async function pageXssCheck() {
  const started = Date.now();
  let rows = [];
  while (Date.now() - started < 12000) {
    rows = Array.from(document.querySelectorAll('#lab-feed-rows .lab-feed-row'));
    if (rows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const feed = document.getElementById('lab-feed-rows');
  const allowed = new Set(['LI', 'TIME', 'B', 'SPAN', 'I', 'SMALL', 'DIV', 'STRONG', 'EM', 'P']);
  const unexpected = [];
  if (feed) {
    for (const el of feed.querySelectorAll('*')) {
      if (!allowed.has(el.tagName)) unexpected.push(el.tagName);
    }
  }
  const inlineHandlers = [];
  if (feed) {
    for (const el of feed.querySelectorAll('*')) {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) inlineHandlers.push(`${el.tagName}[${attr.name}]=${attr.value}`);
      }
    }
  }
  const html = document.documentElement.innerHTML;
  const rawMarkupPresent = /<img[^>]*onerror/i.test(html) || /<svg[^>]*onload/i.test(html);
  const text = feed ? feed.innerText : '';
  const xssFlags = {
    windowUnderscoreXss1: window.__xss === 1,
    windowUnderscoreXss2: window.__xss === 2,
    alertCalled: window.__alertCalled === true,
  };
  const modelText = document.getElementById('m-model')?.textContent ?? null;
  let cspEgressBlocked = null;
  let cspError = null;
  try {
    await fetch('https://example.com/', { mode: 'no-cors' });
    cspEgressBlocked = false;
  } catch (error) {
    cspEgressBlocked = true;
    cspError = String(error && error.message ? error.message : error).slice(0, 200);
  }
  const isolation = {
    processDefined: typeof window.process !== 'undefined',
    requireDefined: typeof window.require !== 'undefined',
    moduleDefined: typeof window.module !== 'undefined',
    preloadApiPresent: typeof window.haloflux !== 'undefined',
    cspMetaPresent: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
  };
  return {
    waitedMs: Date.now() - started,
    rows: rows.length,
    rowTexts: rows.map((row) => row.innerText),
    feedTextContainsLiteralImg: text.includes('<img'),
    feedTextContainsLiteralSvg: text.includes('<svg'),
    injectedElementCount: feed ? feed.querySelectorAll('img,svg,script,iframe,object,embed').length : -1,
    unexpectedTags: [...new Set(unexpected)],
    inlineHandlers,
    rawMarkupPresentInSerializedHtml: rawMarkupPresent,
    xssFlags,
    modelText,
    labConsoleDisplay: document.getElementById('lab-console') ? getComputedStyle(document.getElementById('lab-console')).display : null,
    feedStatus: document.getElementById('lab-feed-status')?.textContent ?? null,
    isolation,
    cspEgressBlocked,
    cspError,
  };
}

/* ---- accessibility: focusables, contrast, reduced motion ---- */
async function pageA11ySnapshot() {
  const parse = (value) => {
    if (!value || value === 'transparent') return null;
    const match = /rgba?\(([^)]+)\)/.exec(value);
    if (!match) return null;
    const parts = match[1].split(',').map((n) => Number(n.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = (rgb) => {
    const channel = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  };
  const over = (top, bottom) => {
    const a = top.a;
    return {
      r: Math.round(top.r * a + bottom.r * (1 - a)),
      g: Math.round(top.g * a + bottom.g * (1 - a)),
      b: Math.round(top.b * a + bottom.b * (1 - a)),
      a: 1,
    };
  };
  const base = { r: 2, g: 2, b: 4, a: 1 }; // #020204, the agent-monitor backdrop
  const effectiveBackground = (el) => {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0) {
        stack.push(color);
        if (color.a >= 1) break;
      }
      node = node.parentElement;
    }
    let result = base;
    for (let i = stack.length - 1; i >= 0; i -= 1) result = over(stack[i], result);
    return result;
  };
  const ratio = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const label = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 60);
    if (el.getAttribute('title')) return el.getAttribute('title');
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const target = document.getElementById(by);
      if (target) return (target.textContent || '').trim().slice(0, 60);
    }
    return '';
  };
  const describe = (el) => ({
    tag: el.tagName,
    id: el.id || null,
    cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
    type: el.tagName === 'INPUT' ? el.type : null,
    name: label(el),
    ariaHidden: el.getAttribute('aria-hidden'),
    tabIndex: el.tabIndex,
    disabled: Boolean(el.disabled),
    visible: visible(el),
    rect: el.getBoundingClientRect().toJSON ? el.getBoundingClientRect().toJSON() : null,
  });
  const hiddenAncestor = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return node.id || node.className || node.tagName;
      node = node.parentElement;
    }
    return null;
  };
  const tabbable = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
    .filter((el) => !el.disabled && el.tabIndex >= 0)
    .filter((el) => visible(el));

  const focusables = tabbable.map((el) => {
    const d = describe(el);
    d.hiddenAncestor = hiddenAncestor(el);
    d.opacity = getComputedStyle(el).opacity;
    return d;
  });

  const presetButtons = Array.from(document.querySelectorAll('#preset-switch button'));
  const hostButtons = Array.from(document.querySelectorAll('#lab-hosts button'));
  const fileInput = document.getElementById('lab-obsidian-file');
  const fileLabel = fileInput ? fileInput.closest('label') : null;
  const targeted = {
    presetButtons: presetButtons.map(describe),
    hostButtons: hostButtons.map(describe),
    fileInput: fileInput
      ? {
          ...describe(fileInput),
          hiddenByDisplay: getComputedStyle(fileInput).display === 'none',
          hiddenByVisibility: getComputedStyle(fileInput).visibility === 'hidden',
          opacity: getComputedStyle(fileInput).opacity,
          size: [fileInput.getBoundingClientRect().width, fileInput.getBoundingClientRect().height],
          name: label(fileInput),
          labelText: fileLabel ? (fileLabel.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
          labelRect: fileLabel ? fileLabel.getBoundingClientRect().toJSON() : null,
          labelOutline: fileLabel ? getComputedStyle(fileLabel).outline : null,
        }
      : null,
  };

  // Contrast for 7-9.99px rendered text.
  const tiny = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent || '').trim();
    if (text.length > 0 && node.parentElement) {
      const el = node.parentElement;
      if (!seen.has(el) && visible(el)) {
        seen.add(el);
        const style = getComputedStyle(el);
        const size = Number.parseFloat(style.fontSize);
        if (size >= 7 && size <= 9.99) {
          const fg = parse(style.color);
          const bg = effectiveBackground(el);
          if (fg) {
            const fgOver = fg.a < 1 ? over(fg, bg) : fg;
            const value = ratio(fgOver, bg);
            tiny.push({
              tag: el.tagName,
              id: el.id || null,
              cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
              text: text.slice(0, 40),
              fontSize: size,
              color: style.color,
              background: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')',
              ratio: Math.round(value * 100) / 100,
              passAA: value >= 4.5,
            });
          }
        }
      }
    }
    node = walker.nextNode();
  }
  const fontSizes = {};
  for (const el of Array.from(document.querySelectorAll('*')).filter(visible)) {
    const size = getComputedStyle(el).fontSize;
    fontSizes[size] = (fontSizes[size] || 0) + 1;
  }

  // Reduced motion: media query + the animations CSS actually applied.
  const animated = ['#link-dot', '.sim-pulse', '.state-dot', '.lab-trace-bar'];
  const motion = {
    mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    statusVersion: document.getElementById('status-version')?.textContent ?? null,
    animationDuration: {},
    transitionDuration: {},
  };
  for (const selector of animated) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    motion.animationDuration[selector] = style.animationDuration;
    motion.transitionDuration[selector] = style.transitionDuration;
  }
  const sampleButton = document.querySelector('#preset-switch button') || document.querySelector('button');
  if (sampleButton) motion.transitionDuration.button = getComputedStyle(sampleButton).transitionDuration;

  // aria-hidden containers that still hold focusable content.
  const ariaHiddenFocusable = [];
  for (const el of Array.from(document.querySelectorAll('[aria-hidden="true"]'))) {
    const focusable = el.querySelectorAll('a[href], button, input, select, textarea, [tabindex]');
    const visibleFocusable = Array.from(focusable).filter((child) => !child.disabled && child.tabIndex >= 0 && visible(child));
    if (visibleFocusable.length > 0) {
      ariaHiddenFocusable.push({ container: el.id || el.className || el.tagName, count: visibleFocusable.length, sample: visibleFocusable.slice(0, 3).map((c) => describe(c)) });
    }
  }

  return {
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    bodyMode: document.body.dataset.mode || null,
    bodyPreset: document.body.dataset.preset || null,
    labConsoleDisplay: document.getElementById('lab-console') ? getComputedStyle(document.getElementById('lab-console')).display : null,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    focusableCount: focusables.length,
    focusables,
    tabbableIds: tabbable.map((el) => el.id || el.className || el.tagName),
    targeted,
    tinyText: tiny,
    tinyFailures: tiny.filter((item) => !item.passAA),
    fontSizes,
    motion,
    ariaHiddenFocusable,
    activeElement: describe(document.activeElement || document.body),
  };
}

function pageActiveInfo() {
  const el = document.activeElement || document.body;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const label = (() => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 50);
  })();
  let outlineTarget = el;
  let outline = style.outline;
  let outlineWidth = style.outlineWidth;
  let outlineStyle = style.outlineStyle;
  let outlineColor = style.outlineColor;
  const fileLabel = el.id === 'lab-obsidian-file' ? el.closest('label') : null;
  if (fileLabel) {
    const ls = getComputedStyle(fileLabel);
    outlineTarget = fileLabel;
    outline = ls.outline;
    outlineWidth = ls.outlineWidth;
    outlineStyle = ls.outlineStyle;
    outlineColor = ls.outlineColor;
  }
  return {
    tag: el.tagName,
    id: el.id || null,
    cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
    name: label,
    tabIndex: el.tabIndex,
    matchesFocusVisible: el.matches(':focus-visible'),
    outline,
    outlineWidth,
    outlineStyle,
    outlineColor,
    outlineTarget: outlineTarget === el ? 'self' : (outlineTarget.className || outlineTarget.tagName),
    boxShadow: style.boxShadow,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    opacity: style.opacity,
  };
}

function pageHostState() {
  const buttons = Array.from(document.querySelectorAll('#lab-hosts button'));
  return {
    count: buttons.length,
    pressed: buttons.map((button) => button.getAttribute('aria-pressed')),
    labels: buttons.map((button) => button.innerText.replace(/\s+/g, ' ').trim()),
    selectedIndex: buttons.findIndex((button) => button.getAttribute('aria-pressed') === 'true'),
  };
}

function pageZoomLayout() {
  const lab = document.getElementById('lab-console');
  const visible = (el) => {
    if (!el) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const clipped = [];
  for (const el of Array.from(document.querySelectorAll('button, input, a[href]')).filter(visible)) {
    const rect = el.getBoundingClientRect();
    if (rect.right > innerWidth + 1 || rect.left < -1 || rect.bottom > innerHeight + 1 || rect.top < -1) {
      clipped.push({ id: el.id || el.className || el.tagName, rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } });
    }
  }
  return {
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    labConsoleDisplay: lab ? getComputedStyle(lab).display : null,
    labConsoleVisible: visible(lab),
    labHostButtons: document.querySelectorAll('#lab-hosts button').length,
    fileInputVisible: visible(document.getElementById('lab-obsidian-file')),
    presetButtons: document.querySelectorAll('#preset-switch button').length,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clippedInteractive: clipped,
    statusbarVisible: visible(document.querySelector('.statusbar')),
    hudVisible: visible(document.querySelector('.hud-layer')),
    agentPanelVisible: visible(document.querySelector('.agent-panel')),
  };
}

async function pageFps(durationMs) {
  const samples = [];
  const start = performance.now();
  let frames = 0;
  let last = performance.now();
  return await new Promise((resolve) => {
    const tick = (now) => {
      frames += 1;
      const delta = now - last;
      if (delta >= 1000) {
        samples.push(Math.round((frames * 1000 / delta) * 100) / 100);
        frames = 0;
        last = now;
      }
      if (now - start < durationMs) {
        requestAnimationFrame(tick);
      } else {
        const heap = performance.memory
          ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize }
          : null;
        resolve({
          samples,
          sampleCount: samples.length,
          hudFps: document.getElementById('perf-fps')?.textContent ?? null,
          hudFrame: document.getElementById('perf-frame')?.textContent ?? null,
          hudQuality: document.getElementById('perf-quality')?.textContent ?? null,
          hudParticles: document.getElementById('perf-particles')?.textContent ?? null,
          statusVersion: document.getElementById('status-version')?.textContent ?? null,
          dpr: devicePixelRatio,
          viewport: [innerWidth, innerHeight],
          heap,
          elapsedMs: Math.round(performance.now() - start),
        });
      }
    };
    requestAnimationFrame(tick);
  });
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    useContentSize: true,
    show: true,
    frame: true,
    backgroundColor: '#020204',
    title: 'HALOFLUX P2 probe',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  const gpuStatus = typeof app.getGPUFeatureStatus === 'function' ? app.getGPUFeatureStatus() : null;

  await win.loadURL(URL);
  wc.setZoomFactor(1);
  win.focus();
  wc.focus();
  await sleep(TASK === 'fps' ? 3500 : 3200);

  if (OPEN_DRAWER) {
    await wc.executeJavaScript(`(() => { const btn = document.getElementById('btn-settings'); if (btn) btn.click(); })()`);
    await sleep(700);
  }

  const ready = await wc.executeJavaScript(`(${pageReadyState.toString()})()`);
  log('ready', JSON.stringify(ready));

  const display = screen.getPrimaryDisplay();
  const displayInfo = {
    size: display.size,
    workAreaSize: display.workAreaSize,
    scaleFactor: display.scaleFactor,
    bounds: display.bounds,
    windowContent: win.getContentSize(),
    windowBounds: win.getBounds(),
  };
  log('display', JSON.stringify(displayInfo));

  let result = { task: TASK, startedAt: new Date().toISOString(), url: ready.href, ready, display: displayInfo, drawerOpened: OPEN_DRAWER, gpu: { enabled: GPU, status: gpuStatus } };

  if (TASK === 'xss') {
    const xss = await wc.executeJavaScript(`(${pageXssCheck.toString()})()`);
    result.xss = xss;
    const problems = [];
    if (xss.rows === 0) problems.push('no lab feed rows rendered — injection path not exercised');
    if (xss.injectedElementCount !== 0) problems.push('injected DOM element(s) present in lab feed');
    if (xss.unexpectedTags.length > 0) problems.push('unexpected tags: ' + xss.unexpectedTags.join(','));
    if (xss.inlineHandlers.length > 0) problems.push('inline handlers: ' + xss.inlineHandlers.join(','));
    if (xss.rawMarkupPresentInSerializedHtml) problems.push('raw <img onerror> present in serialized HTML');
    for (const [flag, value] of Object.entries(xss.xssFlags)) if (value) problems.push('JS payload executed: ' + flag);
    if (!xss.feedTextContainsLiteralImg) problems.push('payload text missing from feed — cannot prove text-only rendering');
    result.xss.verdict = problems.length === 0 ? 'PASS' : 'FAIL';
    result.xss.problems = problems;
  } else if (TASK === 'a11y') {
    const snapshot = await wc.executeJavaScript(`(${pageA11ySnapshot.toString()})()`);
    result.a11y = { snapshot };

    // Real keyboard tab order via OS-level key events.
    const sequence = [];
    let tabMethod = 'sendInputEvent';
    const before = await wc.executeJavaScript(`(${pageActiveInfo.toString()})()`);
    for (let index = 0; index < 60; index += 1) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(70);
      const info = await wc.executeJavaScript(`(${pageActiveInfo.toString()})()`);
      sequence.push(info);
      if (index === 2 && sequence.every((entry) => entry.tag === 'BODY' || entry.tag === 'HTML')) break;
      if (sequence.length > 4 && info.id === sequence[0].id && info.tag === sequence[0].tag && info.name === sequence[0].name) break;
    }
    if (sequence.every((entry) => entry.tag === 'BODY' || entry.tag === 'HTML')) {
      tabMethod = 'programmatic (sendInputEvent did not move focus; window may not be foreground)';
      const ids = snapshot.focusables.map((item) => item.id || item.cls || item.tag);
      sequence.length = 0;
      for (let index = 0; index < Math.min(ids.length, 60); index += 1) {
        await wc.executeJavaScript(
          `(() => { const els = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')).filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length); const target = els[${index}]; if (target) target.focus({ focusVisible: true }); })()`,
        );
        await sleep(40);
        sequence.push(await wc.executeJavaScript(`(${pageActiveInfo.toString()})()`));
      }
    }
    result.a11y.tab = { method: tabMethod, before, sequence };

    // Keyboard operability: a focused host button must activate with Enter/Space.
    const hostBefore = await wc.executeJavaScript(`(${pageHostState.toString()})()`);
    const focusHost = await wc.executeJavaScript(
      `(() => { const btn = document.querySelectorAll('#lab-hosts button')[1] || document.querySelector('#lab-hosts button'); if (!btn) return null; btn.focus({ focusVisible: true }); return { focused: btn.innerText.replace(/\\s+/g, ' ').trim(), activeIsButton: document.activeElement === btn }; })()`,
    );
    let hostAfter = null;
    if (focusHost) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await sleep(350);
      hostAfter = await wc.executeJavaScript(`(${pageHostState.toString()})()`);
      if (hostAfter.selectedIndex === hostBefore.selectedIndex) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await sleep(350);
        hostAfter = await wc.executeJavaScript(`(${pageHostState.toString()})()`);
      }
    }
    result.a11y.hostKeyboard = {
      before: hostBefore,
      focus: focusHost,
      after: hostAfter,
      changedSelection: Boolean(hostBefore && hostAfter && hostAfter.selectedIndex !== hostBefore.selectedIndex),
    };

    result.a11y.focusReachability = {
      presetInTabOrder: sequence.some((entry) => entry.cls && String(entry.cls).includes('preset-btn')),
      presetCount: snapshot.targeted.presetButtons.length,
      presetIds: snapshot.targeted.presetButtons.map((item) => item.id || item.cls || item.tag),
      hostButtonInTabOrder: sequence.some((entry) => entry.cls && String(entry.cls).includes('lab-host')),
      hostButtonCount: snapshot.targeted.hostButtons.length,
      fileInputInTabOrder: sequence.some((entry) => entry.id === 'lab-obsidian-file'),
      fileInputName: snapshot.targeted.fileInput ? snapshot.targeted.fileInput.name : null,
      focusWithoutVisibleOutline: sequence
        .filter((entry) => entry.outlineStyle === 'none' || entry.outlineWidth === '0px')
        .map((entry) => entry.id || entry.cls || entry.tag),
      focusVisibleMatched: sequence.filter((entry) => entry.matchesFocusVisible).length,
      tabStops: sequence.length,
    };

    // Zoom 200%: content must still be available.
    wc.setZoomFactor(2);
    await sleep(900);
    result.a11y.zoom200 = await wc.executeJavaScript(`(${pageZoomLayout.toString()})()`);
    wc.setZoomFactor(1);
    await sleep(500);

    // Small window (below the Paper Lab media-query threshold).
    win.setContentSize(1000, 640);
    await sleep(900);
    result.a11y.smallWindow = await wc.executeJavaScript(`(${pageZoomLayout.toString()})()`);
    win.setContentSize(1600, 900);
    await sleep(600);

    if (SHOT) {
      const image = await wc.capturePage();
      fs.writeFileSync(SHOT, image.toPNG());
      result.a11y.screenshot = SHOT;
    }
  } else if (TASK === 'fps') {
    const before = app.getAppMetrics();
    const fps = await wc.executeJavaScript(`(${pageFps.toString()})(${DURATION})`);
    const after = app.getAppMetrics();
    const rendererTypes = new Set(['Tab', 'Renderer']);
    const summarize = (metrics) =>
      metrics
        .filter((entry) => rendererTypes.has(entry.type))
        .map((entry) => ({ type: entry.type, pid: entry.pid, cpu: entry.cpu, workingSetSize: entry.memory ? entry.memory.workingSetSize : null }));
    result.fps = fps;
    result.rendererMetrics = { before: summarize(before), after: summarize(after) };
    if (SHOT) {
      const image = await wc.capturePage();
      fs.writeFileSync(SHOT, image.toPNG());
      result.shot = SHOT;
    }
  }

  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  log('wrote', OUT);
  win.destroy();
  app.quit();
}

main().catch((error) => {
  try {
    fs.writeFileSync(
      OUT,
      `${JSON.stringify({ task: TASK, fatal: String(error && error.stack ? error.stack : error) }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
  console.error('[probe] fatal:', error);
  app.exit(2);
});
