/**
 * HALOFLUX Universal Agent Visualizer — performance governor.
 *
 * Why this exists (instead of trusting the Canvas engine's own probe):
 *   - the product must be able to promise a *frame cap* (default 60, idle 24),
 *     so the rAF loop belongs to one owner that can skip frames deliberately;
 *   - visibility pauses and reduced-motion are page-level concerns;
 *   - automatic quality reduction must be observable/restartable from the HUD,
 *     which means it cannot hide inside the renderer's private state;
 *   - `destroy()` must leave zero timers, rAF callbacks or listeners, so the
 *     Electron main process can recreate windows without leaking a loop.
 *
 * The governor is DOM-light and injectable (`now` / `raf` / `caf` / `document`)
 * so node:test can drive deterministic frame streams without a browser.
 *
 * License: PolyForm Noncommercial 1.0.0.
 */

/** Quality multipliers: full → ×0.75 → ×0.5. */
export const QUALITY_FACTORS = Object.freeze([1, 0.75, 0.5]);

export const QUALITY_LABELS = Object.freeze(['full', 'reduced', 'minimal']);

export const PERF_DEFAULTS = Object.freeze({
  targetFps: 60,
  idleFps: 24,
  reducedMotionFps: 24,
  lowFps: 42,
  recoverFps: 55,
  lowWindowMs: 1200,
  recoveryWindowMs: 2500,
  cooldownMs: 3000,
  statsIntervalMs: 500,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** DPR is clamped to [1, 3]: enough for 200–300% Windows scaling, bounded. */
export function clampDpr(dpr) {
  const n = Number(dpr);
  return Number.isFinite(n) && n > 0 ? clamp(n, 1, 3) : 1;
}

/** Quality level 0..2 → multiplier (0.75 / 0.5 steps, never zero). */
export function qualityFactor(level) {
  const index = clamp(Math.round(Number(level) || 0), 0, QUALITY_FACTORS.length - 1);
  return QUALITY_FACTORS[index];
}

function defaultNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function defaultRaf(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  if (typeof setTimeout === 'function') return setTimeout(() => callback(defaultNow()), 16);
  return 0;
}

function defaultCaf(handle) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else if (typeof clearTimeout === 'function') clearTimeout(handle);
}

/**
 * Create a frame governor.
 *
 * @param {object} [options]
 * @param {(dt:number, meta:object)=>void} [options.onFrame] called with seconds since the previous rendered frame
 * @param {(stats:object)=>void} [options.onStats] called at `statsIntervalMs`
 * @param {(level:number, factor:number)=>void} [options.onQuality] called when the automatic quality level changes
 * @param {()=>boolean} [options.isIdle] idle sessions use `idleFps` instead of `targetFps`
 * @param {()=>number} [options.getParticles] particle count for the stats object
 * @param {Document} [options.document] visibility source (defaults to global document)
 * @param {()=>number} [options.now] injectable clock (tests)
 * @param {(cb:Function)=>number} [options.raf] injectable rAF (tests)
 * @param {(handle:number)=>void} [options.caf] injectable cancel (tests)
 * @param {boolean} [options.watchdog] fall back to a timer when rAF is throttled
 */
export function createPerfGovernor(options = {}) {
  const settings = { ...PERF_DEFAULTS };
  if (Number.isFinite(options.targetFps)) settings.targetFps = clamp(Number(options.targetFps), 1, 240);
  if (Number.isFinite(options.idleFps)) settings.idleFps = clamp(Number(options.idleFps), 1, 240);
  if (Number.isFinite(options.reducedMotionFps)) settings.reducedMotionFps = clamp(Number(options.reducedMotionFps), 1, 240);
  if (Number.isFinite(options.lowFps)) settings.lowFps = Number(options.lowFps);
  if (Number.isFinite(options.recoverFps)) settings.recoverFps = Number(options.recoverFps);
  if (Number.isFinite(options.lowWindowMs)) settings.lowWindowMs = Math.max(0, Number(options.lowWindowMs));
  if (Number.isFinite(options.recoveryWindowMs)) settings.recoveryWindowMs = Math.max(0, Number(options.recoveryWindowMs));
  if (Number.isFinite(options.cooldownMs)) settings.cooldownMs = Math.max(0, Number(options.cooldownMs));
  if (Number.isFinite(options.statsIntervalMs)) settings.statsIntervalMs = Math.max(50, Number(options.statsIntervalMs));

  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};
  const onStats = typeof options.onStats === 'function' ? options.onStats : null;
  const onQuality = typeof options.onQuality === 'function' ? options.onQuality : null;
  const isIdle = typeof options.isIdle === 'function' ? options.isIdle : () => false;
  const getParticles = typeof options.getParticles === 'function' ? options.getParticles : () => 0;
  const doc = options.document !== undefined
    ? options.document
    : (typeof document !== 'undefined' ? document : null);
  const now = typeof options.now === 'function' ? options.now : defaultNow;
  const raf = typeof options.raf === 'function' ? options.raf : defaultRaf;
  const caf = typeof options.caf === 'function' ? options.caf : defaultCaf;

  let running = false;
  let paused = false;
  let destroyed = false;
  let hidden = !!(doc && doc.hidden);
  let rafHandle = 0;
  let lastTickAt = 0;
  let lastRenderAt = 0;
  let lastTickDelta = 0;
  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  let totalFrames = 0;
  let fps = 0;
  let frameMs = 0;
  let rawFps = settings.targetFps;
  let qualityLevel = 0;
  let lowFor = 0;
  let goodFor = 0;
  let lastQualityChangeAt = -Infinity;
  let lastStatsAt = 0;
  let reducedMotion = !!options.reducedMotion;
  let listenerAttached = false;
  let watchdogTimer = null;
  let watchdogEnabled = options.watchdog === true;

  function effectiveFpsCap() {
    const target = isIdle() ? Math.min(settings.targetFps, settings.idleFps) : settings.targetFps;
    const cap = reducedMotion ? Math.min(target, settings.reducedMotionFps) : target;
    return Math.max(1, cap);
  }

  function currentQuality() {
    return qualityFactor(qualityLevel);
  }

  function emitStats(time) {
    const elapsed = time - fpsWindowStart;
    if (elapsed > 0) fps = Math.round((fpsWindowFrames * 1000 / elapsed) * 10) / 10;
    fpsWindowStart = time;
    fpsWindowFrames = 0;
    lastStatsAt = time;
    let particles = 0;
    try { particles = Number(getParticles()) || 0; } catch { particles = 0; }
    const stats = {
      fps,
      frameMs: Math.round(frameMs * 100) / 100,
      quality: currentQuality(),
      qualityLevel,
      particles,
      frames: totalFrames,
      paused: paused || hidden,
      running,
      reducedMotion,
      targetFps: settings.targetFps,
      effectiveFps: effectiveFpsCap(),
      idle: !!isIdle(),
    };
    if (onStats) {
      try { onStats(stats); } catch { /* a HUD callback must not kill the loop */ }
    }
  }

  function applyQuality(nextLevel) {
    const next = clamp(Math.round(nextLevel), 0, QUALITY_FACTORS.length - 1);
    if (next === qualityLevel) return;
    qualityLevel = next;
    if (onQuality) {
      try { onQuality(qualityLevel, currentQuality()); } catch { /* ignore */ }
    }
  }

  function updateQuality(time, deltaMs) {
    const cap = effectiveFpsCap();
    // Never auto-degrade when the configured cap is already low: the measured
    // cadence would only be measuring our own cap, not the machine's headroom.
    if (cap < settings.recoverFps) {
      lowFor = 0;
      goodFor = 0;
      return;
    }
    const delta = Math.max(0, deltaMs);
    if (rawFps < settings.lowFps) {
      lowFor += delta;
      goodFor = 0;
      if (lowFor >= settings.lowWindowMs && time - lastQualityChangeAt >= settings.cooldownMs) {
        applyQuality(qualityLevel + 1);
        lowFor = 0;
        lastQualityChangeAt = time;
      }
    } else if (rawFps > settings.recoverFps) {
      goodFor += delta;
      lowFor = Math.max(0, lowFor - delta * 0.5);
      if (goodFor >= settings.recoveryWindowMs && qualityLevel > 0 && time - lastQualityChangeAt >= settings.cooldownMs) {
        applyQuality(qualityLevel - 1);
        goodFor = 0;
        lastQualityChangeAt = time;
      }
    } else {
      lowFor = Math.max(0, lowFor - delta * 0.5);
      goodFor = 0;
    }
  }

  function tick(timestamp) {
    rafHandle = 0;
    if (!running || destroyed) return;
    schedule();
    if (paused) return;
    if (doc && doc.hidden) { hidden = true; return; }
    hidden = false;

    const time = Number.isFinite(timestamp) ? Number(timestamp) : now();
    let tickDelta = 0;
    if (lastTickAt > 0) {
      tickDelta = Math.max(0, time - lastTickAt);
      lastTickDelta = tickDelta;
      // Eased rAF cadence: one hiccup must not trip the quality governor.
      if (tickDelta > 0) {
        const inst = 1000 / tickDelta;
        rawFps += (inst - rawFps) * (1 - Math.exp(-tickDelta / 250));
      }
    } else {
      fpsWindowStart = time;
      lastStatsAt = time;
    }
    lastTickAt = time;

    const cap = effectiveFpsCap();
    const interval = 1000 / cap;
    // Frame cap: skip the rAF callback until the budget allows a draw. The
    // -0.75ms tolerance avoids a 60fps cap accidentally becoming 30fps on a
    // 60Hz display because of timestamp jitter.
    if (lastRenderAt > 0 && time - lastRenderAt < interval - 0.75) return;
    const elapsedSinceRender = lastRenderAt > 0 ? Math.min(100, time - lastRenderAt) : interval;
    lastRenderAt = time;

    const frameStart = now();
    try {
      onFrame(elapsedSinceRender / 1000, {
        quality: currentQuality(),
        qualityLevel,
        fpsCap: cap,
        time,
      });
    } catch {
      /* a throwing frame renderer must not stop the shared rAF loop */
    }
    const cost = Math.max(0, now() - frameStart);
    frameMs += (cost - frameMs) * 0.1;

    totalFrames += 1;
    fpsWindowFrames += 1;
    updateQuality(time, tickDelta);
    if (time - lastStatsAt >= settings.statsIntervalMs) emitStats(time);
  }

  function schedule() {
    if (!running || destroyed || paused || rafHandle) return;
    try {
      rafHandle = Number(raf(tick)) || 0;
    } catch {
      rafHandle = 0;
    }
  }

  function cancel() {
    if (rafHandle) {
      try { caf(rafHandle); } catch { /* ignore */ }
      rafHandle = 0;
    }
  }

  /**
   * Electron/hidden-window safety net. A background window can throttle rAF to
   * ~1 Hz even with `backgroundThrottling: false` in some compositor paths. The
   * watchdog only fires when no rAF callback has arrived for 3× the frame
   * budget, so it is a no-op on a healthy 60 Hz page; it keeps captures and
   * low-power windows from freezing mid-envelope. Cleared by pause/stop/destroy.
   */
  function startWatchdog() {
    if (!watchdogEnabled || watchdogTimer !== null || destroyed) return;
    if (typeof setInterval !== 'function') return;
    watchdogTimer = setInterval(() => {
      if (!running || paused || destroyed) return;
      if (doc && doc.hidden) return;
      const nowValue = now();
      const budget = Math.max(150, (1000 / Math.max(1, effectiveFpsCap())) * 3);
      if (nowValue - lastTickAt > budget) tick(nowValue);
    }, 120);
  }

  function stopWatchdog() {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function onVisibilityChange() {
    if (destroyed) return;
    const isHidden = !!(doc && doc.hidden);
    if (isHidden && !hidden) {
      hidden = true;
      cancel();
      stopWatchdog();
    } else if (!isHidden && hidden) {
      hidden = false;
      if (running && !paused) {
        lastTickAt = 0;
        lastRenderAt = 0;
        schedule();
        startWatchdog();
      }
    }
  }

  if (doc && typeof doc.addEventListener === 'function') {
    try {
      doc.addEventListener('visibilitychange', onVisibilityChange);
      listenerAttached = true;
    } catch { listenerAttached = false; }
  }

  return {
    start() {
      if (destroyed) return false;
      if (running) return true;
      running = true;
      paused = false;
      lastTickAt = 0;
      lastRenderAt = 0;
      lastTickDelta = 0;
      fpsWindowStart = 0;
      fpsWindowFrames = 0;
      lastStatsAt = 0;
      if (hidden) return true; // visible event will schedule
      schedule();
      startWatchdog();
      return true;
    },
    stop() {
      running = false;
      paused = false;
      cancel();
      stopWatchdog();
    },
    pause() {
      if (destroyed) return;
      paused = true;
      cancel();
      stopWatchdog();
    },
    resume() {
      if (destroyed) return;
      paused = false;
      if (running && !hidden) {
        lastTickAt = 0;
        lastRenderAt = 0;
        schedule();
        startWatchdog();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      paused = false;
      cancel();
      stopWatchdog();
      if (listenerAttached && doc && typeof doc.removeEventListener === 'function') {
        try { doc.removeEventListener('visibilitychange', onVisibilityChange); } catch { /* ignore */ }
      }
      listenerAttached = false;
    },
    /** Manual quality override (e.g. a settings toggle). */
    setQuality(level) {
      applyQuality(level);
    },
    setTargetFps(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      settings.targetFps = clamp(n, 1, 240);
      lastRenderAt = 0;
    },
    setIdleFps(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      settings.idleFps = clamp(n, 1, 240);
      lastRenderAt = 0;
    },
    setReducedMotion(value) {
      reducedMotion = !!value;
      lastRenderAt = 0;
    },
    isRunning: () => running,
    isPaused: () => paused,
    isHidden: () => hidden,
    isDestroyed: () => destroyed,
    getQualityLevel: () => qualityLevel,
    getQualityFactor: currentQuality,
    getFpsCap: effectiveFpsCap,
    getStats() {
      let particles = 0;
      try { particles = Number(getParticles()) || 0; } catch { particles = 0; }
      return {
        fps: Math.round(fps * 10) / 10,
        frameMs: Math.round(frameMs * 100) / 100,
        quality: currentQuality(),
        qualityLevel,
        particles,
        frames: totalFrames,
        paused: paused || hidden,
        running,
        reducedMotion,
        targetFps: settings.targetFps,
        effectiveFps: effectiveFpsCap(),
        idle: !!isIdle(),
      };
    },
    /** test/diagnostic helper: current raw rAF cadence estimate */
    getRawFps: () => Math.round(rawFps * 10) / 10,
    getLastTickDelta: () => lastTickDelta,
  };
}

/**
 * Observe the viewport and report CSS size + DPR changes.
 *
 * Deliberately *not* a rAF loop: Electron fires `resize` per drag frame, and the
 * engine already skips rebuilds when the size is unchanged. Returns a handle
 * whose `destroy()` removes every listener (no timers involved).
 */
export function createViewportWatcher(options = {}) {
  const win = options.window !== undefined
    ? options.window
    : (typeof window !== 'undefined' ? window : null);
  const canvas = options.canvas || null;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const explicitDpr = Number(options.dpr);
  const hasExplicitDpr = Number.isFinite(explicitDpr) && explicitDpr > 0;

  function measure() {
    let width = 0;
    let height = 0;
    try {
      if (typeof options.getSize === 'function') {
        const size = options.getSize();
        if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
          width = size.width;
          height = size.height;
        }
      }
      if ((!width || !height) && canvas && typeof canvas.getBoundingClientRect === 'function') {
        const rect = canvas.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          width = rect.width;
          height = rect.height;
        }
      }
    } catch { /* ignore */ }
    if (!width || !height) {
      width = (canvas && canvas.clientWidth) || (win && win.innerWidth) || 0;
      height = (canvas && canvas.clientHeight) || (win && win.innerHeight) || 0;
    }
    const dpr = clampDpr(hasExplicitDpr ? explicitDpr : (win && win.devicePixelRatio) || 1);
    return { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)), dpr };
  }

  let mediaQuery = null;
  function onResize() {
    const size = measure();
    if (size.width > 0 && size.height > 0) onChange(size);
  }

  const listeners = [];
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('resize', onResize);
    listeners.push(() => win.removeEventListener('resize', onResize));
    if (win.visualViewport && typeof win.visualViewport.addEventListener === 'function') {
      win.visualViewport.addEventListener('resize', onResize);
      listeners.push(() => win.visualViewport.removeEventListener('resize', onResize));
    }
    if (typeof win.matchMedia === 'function') {
      try {
        mediaQuery = win.matchMedia(`(resolution: ${measure().dpr}dppx)`);
        mediaQuery.addEventListener('change', onResize);
        listeners.push(() => mediaQuery.removeEventListener('change', onResize));
      } catch { mediaQuery = null; }
    }
  }

  return {
    measure,
    refresh: onResize,
    destroy() {
      for (const remove of listeners.splice(0)) {
        try { remove(); } catch { /* ignore */ }
      }
      mediaQuery = null;
    },
  };
}
