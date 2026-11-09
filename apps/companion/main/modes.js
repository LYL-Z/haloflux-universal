/**
 * Window-mode helpers for the HALOFLUX companion.
 *
 * Three modes (contract §3 / task):
 *  - window  : normal 1200×800 frame, resizable / movable / fullscreen
 *  - overlay : transparent, frameless, always-on-top 'screen-saver', skipTaskbar,
 *              adjustable opacity, click-through toggle
 *  - compact : 320×320 frameless always-on-top corner window
 *
 * Multi-display / DPI: bounds are computed in DIPs and mapped through
 * screen.getDisplayMatching(); the returned display id + scaleFactor are stored
 * with the bounds so a restart lands on the same monitor. Chromium rasterizes at
 * the display's device pixel ratio, so zoomFactor is kept DPR-aware (clamped to
 * 1.5) instead of scaling through a blurry bitmap.
 */

import { screen } from 'electron';

export const MODES = Object.freeze(['window', 'overlay', 'compact']);
export const MODE_LABELS = Object.freeze({ window: '窗口模式', overlay: '悬浮模式', compact: '紧凑模式' });
export const COMPANION_VERSION = '0.1.0';

export const WINDOW_DEFAULT_SIZE = Object.freeze({ width: 1200, height: 800 });
export const COMPACT_SIZE = Object.freeze({ width: 320, height: 320 });
export const MIN_WINDOW_SIZE = Object.freeze({ width: 480, height: 360 });

export function normalizeMode(mode, fallback = 'window') {
  return MODES.includes(mode) ? mode : fallback;
}

export function clampNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidBounds(bounds) {
  return (
    bounds &&
    isFiniteNumber(bounds.x) &&
    isFiniteNumber(bounds.y) &&
    isFiniteNumber(bounds.width) &&
    isFiniteNumber(bounds.height) &&
    bounds.width >= 1 &&
    bounds.height >= 1
  );
}

/** Clamp arbitrary bounds into a display work area (DIPs). */
export function clampBoundsToDisplay(bounds, display) {
  const area = display.workArea;
  const width = Math.max(1, Math.min(Math.round(bounds.width), area.width));
  const height = Math.max(1, Math.min(Math.round(bounds.height), area.height));
  const x = Math.min(Math.max(Math.round(bounds.x), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(bounds.y), area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/**
 * Resolve where a mode window should open.
 * @param {{mode: string, savedBounds?: object|null, display?: Electron.Display}} input
 */
export function resolveBounds({ mode, savedBounds = null, display = null }) {
  const primary = display || screen.getPrimaryDisplay();
  const savedDisplay =
    isValidBounds(savedBounds) && screen.getAllDisplays().some((candidate) => candidate.id === savedBounds.displayId)
      ? screen.getAllDisplays().find((candidate) => candidate.id === savedBounds.displayId)
      : isValidBounds(savedBounds)
        ? screen.getDisplayMatching(savedBounds)
        : primary;
  const targetDisplay = savedDisplay || primary;
  const area = targetDisplay.workArea;

  if (mode === 'overlay') {
    // Overlay always covers the whole work area of its display.
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  }
  if (mode === 'compact') {
    if (isValidBounds(savedBounds)) {
      return clampBoundsToDisplay({ ...savedBounds, width: COMPACT_SIZE.width, height: COMPACT_SIZE.height }, targetDisplay);
    }
    return {
      x: area.x + area.width - COMPACT_SIZE.width - 24,
      y: area.y + 24,
      width: COMPACT_SIZE.width,
      height: COMPACT_SIZE.height,
    };
  }
  if (isValidBounds(savedBounds)) {
    return clampBoundsToDisplay(
      {
        ...savedBounds,
        width: Math.max(MIN_WINDOW_SIZE.width, savedBounds.width),
        height: Math.max(MIN_WINDOW_SIZE.height, savedBounds.height),
      },
      targetDisplay,
    );
  }
  const width = Math.min(WINDOW_DEFAULT_SIZE.width, area.width);
  const height = Math.min(WINDOW_DEFAULT_SIZE.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * DPR-aware zoom. Chromium already rasterizes the page at the display's device
 * pixel ratio (window.devicePixelRatio === display.scaleFactor when zoomFactor is
 * 1), so keeping zoomFactor 1 is what makes text/canvas sharp without turning a
 * 1200×800 window into a 3000×1900 software-rendered surface. A numeric override
 * (HALOFLUX_COMPANION_ZOOM) or HALOFLUX_ZOOM_FOLLOW_DPR=1 can scale the HUD for
 * very high-DPI panels; the value is clamped so the CSS viewport stays usable.
 */
export function resolveZoomFactor(display, override = undefined) {
  const numeric = Number(override);
  if (Number.isFinite(numeric) && numeric >= 0.5 && numeric <= 3) return numeric;
  if (process.env.HALOFLUX_ZOOM_FOLLOW_DPR === '1') {
    const dpr = display && Number.isFinite(display.scaleFactor) ? display.scaleFactor : 1;
    return Math.min(1.5, Math.max(1, Math.round(dpr * 100) / 100));
  }
  return 1;
}

/** BrowserWindow options per mode (pure; callers pass Electron paths). */
export function windowOptionsForMode({
  mode,
  bounds,
  preloadPath,
  settings,
  demo = false,
  devTools = false,
  zoomFactor = 1,
}) {
  const common = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    title: 'HALOFLUX Companion',
    backgroundColor: '#0a0b0f',
    autoHideMenuBar: true,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools,
      zoomFactor,
    },
  };

  if (mode === 'overlay') {
    return {
      ...common,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      roundedCorners: false,
      acceptFirstMouse: true,
      focusable: true,
      ...(demo ? { title: 'HALOFLUX Companion (demo)' } : {}),
    };
  }
  if (mode === 'compact') {
    return {
      ...common,
      width: COMPACT_SIZE.width,
      height: COMPACT_SIZE.height,
      minWidth: COMPACT_SIZE.width,
      minHeight: COMPACT_SIZE.height,
      // Interpret 320×320 as the web content viewport (frameless window borders
      // can add a few DIPs on Windows). Renderer reads innerWidth, so keep the
      // contract exact: viewport === 320×320.
      useContentSize: true,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      resizable: false,
      movable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
    };
  }
  return {
    ...common,
    frame: true,
    transparent: false,
    alwaysOnTop: Boolean(settings && settings.companion && settings.companion.alwaysOnTop),
    skipTaskbar: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
  };
}

/** Apply per-mode window policies that are not constructor options. */
export function applyModeToWindow(win, { mode, clickThrough = false, opacity = 1, alwaysOnTop = false }) {
  if (!win || win.isDestroyed()) return;
  if (mode === 'overlay') {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setSkipTaskbar(true);
    win.setOpacity(clampNumber(opacity, 0.1, 1));
    win.setIgnoreMouseEvents(Boolean(clickThrough), { forward: true });
    return;
  }
  if (mode === 'compact') {
    win.setAlwaysOnTop(true, 'floating');
    win.setSkipTaskbar(true);
    win.setOpacity(1);
    win.setIgnoreMouseEvents(false);
    return;
  }
  win.setAlwaysOnTop(Boolean(alwaysOnTop), 'normal');
  win.setSkipTaskbar(false);
  win.setOpacity(1);
  win.setIgnoreMouseEvents(false);
}

/** Compute bounds plus display metadata for persistence. */
export function boundsWithDisplay(bounds) {
  const display = screen.getDisplayMatching(bounds);
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    displayId: display.id,
    scaleFactor: display.scaleFactor,
  };
}

/** Re-apply zoom (and clamp overlay/compact bounds) after DPI changes. */
export function applyDisplayMetrics(win, { mode, zoomOverride } = {}) {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const zoomFactor = resolveZoomFactor(display, zoomOverride);
  try {
    win.webContents.setZoomFactor(zoomFactor);
  } catch {
    /* webContents might not be ready yet */
  }
  if (mode === 'overlay' || mode === 'compact') {
    const clamped = clampBoundsToDisplay(bounds, display);
    if (clamped.x !== bounds.x || clamped.y !== bounds.y || clamped.width !== bounds.width || clamped.height !== bounds.height) {
      win.setBounds(clamped);
    }
  }
  return { display, zoomFactor };
}
