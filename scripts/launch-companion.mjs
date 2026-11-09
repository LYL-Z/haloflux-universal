#!/usr/bin/env node
/**
 * HALOFLUX companion launcher.
 *
 * Resolves the already-installed Electron (no download, no npm install):
 *   1. $HALOFLUX_ELECTRON
 *   2. node_modules/electron/dist/electron.exe (if a local Electron exists)
 *   3. C:\Users\Lenovo\.dsh\electron\electron.exe (Electron 43.3.0 from DSH)
 *   4. `electron` found on PATH
 *
 * Spawns exactly `electron.exe apps/companion/main/main.js` with NO extra argv:
 * on this machine Electron 43.3.0 can hard-exit (exit -1, no log) when a
 * `file://` URL appears in argv together with other arguments, so every
 * --mode/--demo/--bridge-url/--token flag is forwarded through environment
 * variables that main.js reads. The child's exit code is propagated verbatim.
 *
 * Environment prepared for the child:
 *   ELECTRON_RUN_AS_NODE is deleted (it is set globally on this machine and
 *   would turn Electron into plain Node), HALOFLUX_MODE, HALOFLUX_DEMO,
 *   HALOFLUX_BRIDGE_URL, HALOFLUX_TOKEN, HALOFLUX_CLICK_THROUGH,
 *   HALOFLUX_OPACITY, HALOFLUX_SCREENSHOT, HALOFLUX_EXIT_AFTER,
 *   HALOFLUX_SELFTEST.
 *
 * GPU note: hardware acceleration is ON by default (the HUD must not slow the
 * agent). `--software-render` / HALOFLUX_SOFTWARE_RENDER=1 disables it for
 * CI/screenshot runs. If the GPU attempt dies before the window writes
 * HALOFLUX_READY_FILE, this launcher retries once with software rendering and
 * records that fallback (set HALOFLUX_GPU_FALLBACK=0 to disable the retry).
 * `--no-sandbox` is only forwarded when explicitly requested.
 *
 * Usage:
 *   node scripts/launch-companion.mjs [--mode window|overlay|compact] [--demo]
 *     [--bridge-url http://127.0.0.1:17817] [--token <token>]
 *     [--click-through] [--opacity 0.75] [--software-render]
 *     [--screenshot screenshots/bridge-window.png]
 *     [--exit-after 5000] [--headless-selftest] [--print-electron]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_MAIN = path.join(ROOT, 'apps', 'companion', 'main', 'main.js');
const PKG_DIR = path.join(ROOT, 'node_modules', 'electron');

function parseArgs(argv) {
  const args = {
    mode: '',
    demo: false,
    bridgeUrl: '',
    token: '',
    clickThrough: false,
    opacity: '',
    screenshot: '',
    screenshotDelay: '',
    exitAfter: 0,
    headlessSelftest: false,
    softwareRender: false,
    printElectron: false,
    passthrough: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => (inlineValue !== null ? inlineValue : next());
    switch (name) {
      case '--mode':
        args.mode = value();
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--bridge-url':
        args.bridgeUrl = value();
        break;
      case '--token':
        args.token = value();
        break;
      case '--click-through':
        args.clickThrough = true;
        break;
      case '--opacity':
        args.opacity = value();
        break;
      case '--screenshot':
        args.screenshot = value();
        break;
      case '--screenshot-delay':
        args.screenshotDelay = value();
        break;
      case '--exit-after':
        args.exitAfter = Number(value());
        break;
      case '--headless-selftest':
        args.headlessSelftest = true;
        break;
      case '--software-render':
        args.softwareRender = true;
        break;
      case '--print-electron':
        args.printElectron = true;
        break;
      case '--no-sandbox':
        args.passthrough.push('--no-sandbox');
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    }
  }
  return args;
}

function fileExecutable(candidate) {
  try {
    if (!candidate) return '';
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return '';
    return candidate;
  } catch {
    return '';
  }
}

function pathLookup(name) {
  const pathValue = process.env.PATH || process.env.Path || '';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = fileExecutable(path.join(directory, `${name}${extension}`));
      if (candidate) return candidate;
    }
  }
  return '';
}

function localElectron() {
  if (process.platform === 'win32') return fileExecutable(path.join(PKG_DIR, 'dist', 'electron.exe'));
  if (process.platform === 'darwin') {
    return fileExecutable(path.join(PKG_DIR, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  }
  return fileExecutable(path.join(PKG_DIR, 'dist', 'electron'));
}

/** Resolve Electron per the documented order. */
export function resolveElectron(env = process.env) {
  const fromEnv = fileExecutable(env.HALOFLUX_ELECTRON);
  if (fromEnv) return { path: fromEnv, source: 'HALOFLUX_ELECTRON' };

  const local = localElectron();
  if (local) return { path: local, source: 'node_modules/electron' };

  if (process.platform === 'win32') {
    const dsh = fileExecutable('C:\\Users\\Lenovo\\.dsh\\electron\\electron.exe');
    if (dsh) return { path: dsh, source: 'dsh-electron-43.3.0' };
  }

  const onPath = pathLookup('electron');
  if (onPath) return { path: onPath, source: 'PATH' };

  return { path: '', source: 'not-found' };
}

export function buildChildEnv(options, env = process.env) {
  const childEnv = {
    ...env,
    HALOFLUX_MODE: options.mode || env.HALOFLUX_MODE || '',
    HALOFLUX_DEMO: options.demo || env.HALOFLUX_DEMO === '1' ? '1' : '0',
    HALOFLUX_CLICK_THROUGH: options.clickThrough ? '1' : env.HALOFLUX_CLICK_THROUGH || '0',
    HALOFLUX_SOFTWARE_RENDER: options.softwareRender ? '1' : env.HALOFLUX_SOFTWARE_RENDER || '0',
    HALOFLUX_ELECTRON: '',
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (options.bridgeUrl) childEnv.HALOFLUX_BRIDGE_URL = options.bridgeUrl;
  if (options.token) childEnv.HALOFLUX_TOKEN = options.token;
  if (options.opacity !== '') childEnv.HALOFLUX_OPACITY = String(options.opacity);
  if (options.screenshot) childEnv.HALOFLUX_SCREENSHOT = options.screenshot;
  if (options.screenshotDelay !== '') childEnv.HALOFLUX_SCREENSHOT_DELAY = String(options.screenshotDelay);
  if (options.exitAfter > 0) childEnv.HALOFLUX_EXIT_AFTER = String(options.exitAfter);
  if (options.headlessSelftest) {
    childEnv.HALOFLUX_SELFTEST = '1';
    if (!(options.exitAfter > 0)) childEnv.HALOFLUX_EXIT_AFTER = '5000';
  }
  return childEnv;
}

function helpText() {
  return [
    'usage: node scripts/launch-companion.mjs [options]',
    '',
    '  --mode <window|overlay|compact>   initial window mode (default from settings)',
    '  --demo                            demo/simulated watermark flag for the renderer',
    '  --bridge-url <url>                default http://127.0.0.1:17817',
    '  --token <token>                   explicit bridge token (default token file)',
    '  --click-through                   start overlay in click-through mode',
    '  --opacity <0.1..1>                overlay opacity',
    '  --screenshot <png>                capture the window then quit (evidence/CI)',
    '  --screenshot-delay <ms>           wait before capture (default 2200)',
    '  --exit-after <ms>                 quit automatically after N ms',
    '  --headless-selftest               start, verify, auto-quit after 5 s (CI smoke)',
    '  --software-render                 disable GPU (CI/screenshots); GPU is on by default',
    '  --print-electron                  print the resolved Electron path and exit',
    '  --no-sandbox                      add --no-sandbox (only if the GPU sandbox blocks)',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[launch] ${error.message}`);
    console.error(helpText());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(helpText());
    return;
  }

  const electron = resolveElectron(process.env);
  if (args.printElectron) {
    console.log(JSON.stringify(electron));
    if (!electron.path) process.exitCode = 1;
    return;
  }
  if (!electron.path) {
    console.error('[launch] Electron not found. Set HALOFLUX_ELECTRON to electron.exe,');
    console.error('[launch] install electron under node_modules/electron, or use the DSH build at');
    console.error('[launch] C:\\Users\\Lenovo\\.dsh\\electron\\electron.exe');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(APP_MAIN)) {
    console.error(`[launch] app entry missing: ${APP_MAIN}`);
    process.exitCode = 2;
    return;
  }

  const childEnv = buildChildEnv(args);
  const electronArgs = [APP_MAIN, ...args.passthrough];
  if (args.headlessSelftest) args.exitAfter = args.exitAfter > 0 ? args.exitAfter : 5000;
  console.log(`[launch] electron=${electron.path} (${electron.source})`);
  console.log(`[launch] mode=${args.mode || '(settings)'} demo=${args.demo ? '1' : '0'} bridge=${args.bridgeUrl || '(env/settings)'}`);
  console.log(`[launch] argv=[${path.basename(APP_MAIN)}${args.passthrough.length ? ` ${args.passthrough.join(' ')}` : ''}] (config via environment)`);

  let currentChild = null;
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    process.exitCode = code;
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (currentChild && !currentChild.killed) {
        try {
          currentChild.kill(signal);
        } catch {
          /* already gone */
        }
      }
    });
  }

  const spawnOnce = (attemptEnv) =>
    new Promise((resolve) => {
      const child = spawn(electron.path, electronArgs, {
        cwd: ROOT,
        env: attemptEnv,
        stdio: 'inherit',
        windowsHide: false,
      });
      currentChild = child;
      child.on('error', (error) => {
        console.error(`[launch] failed to spawn Electron: ${error && error.message ? error.message : error}`);
        resolve({ code: 1, signal: null, spawnError: true });
      });
      child.on('exit', (code, signal) => {
        currentChild = null;
        if (signal) console.error(`[launch] Electron terminated by ${signal}`);
        resolve({ code: typeof code === 'number' ? code : 1, signal });
      });
    });

  const requestedSoftware = args.softwareRender || process.env.HALOFLUX_SOFTWARE_RENDER === '1';
  const gpuFallbackAllowed = process.env.HALOFLUX_GPU_FALLBACK !== '0';
  let finalCode = 1;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const useSoftware = requestedSoftware || attempt > 0;
    const readyFile = path.join(os.tmpdir(), `haloflux-companion-ready-${process.pid}-${attempt}.json`);
    try {
      fs.rmSync(readyFile, { force: true });
    } catch {
      /* ignore */
    }
    const attemptEnv = {
      ...childEnv,
      HALOFLUX_SOFTWARE_RENDER: useSoftware ? '1' : '0',
      HALOFLUX_READY_FILE: readyFile,
    };
    console.log(
      `[launch] attempt ${attempt + 1}/2 rendering=${useSoftware ? 'software' : 'gpu'} readyFile=${readyFile}`,
    );
    const result = await spawnOnce(attemptEnv);

    let ready = null;
    try {
      if (fs.existsSync(readyFile)) ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    } catch {
      ready = null;
    }
    try {
      fs.rmSync(readyFile, { force: true });
    } catch {
      /* ignore */
    }

    if (ready) {
      console.log(`[launch] window ready pid=${ready.pid} mode=${ready.mode} softwareRender=${ready.softwareRender}`);
      finalCode = result.code;
      break;
    }

    const gpuAttempt = !useSoftware;
    if (gpuAttempt && gpuFallbackAllowed && !result.spawnError && result.code !== 0) {
      console.warn(
        `[launch] GPU attempt exited (code=${result.code}${result.signal ? ` signal=${result.signal}` : ''}) before the window became ready; ` +
          'retrying once with software rendering (HALOFLUX_GPU_FALLBACK=0 disables this fallback)',
      );
      finalCode = result.code;
      // Let the crashed instance release its single-instance lock / userData.
      await new Promise((resolve) => setTimeout(resolve, 750));
      continue;
    }

    console.warn(`[launch] Electron exited (code=${result.code}${result.signal ? ` signal=${result.signal}` : ''}) without a ready marker`);
    finalCode = result.code;
    break;
  }

  finish(finalCode);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[launch] fatal: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
}
