/**
 * Test doubles for packages/visual-core tests. Not a test file on its own.
 */

const GRADIENT = Object.freeze({ addColorStop() {} });

/**
 * A canvas 2D context that accepts every call the engine makes without doing
 * any drawing. The engine requires real offscreen canvases to render, so these
 * tests deliberately exercise the non-render paths (params, state mapping, perf
 * governor lifecycle) and never assert pixels.
 */
export function createFakeContext() {
  const target = {
    canvas: null,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    filter: 'none',
    lineDashOffset: 0,
    createRadialGradient: () => GRADIENT,
    createLinearGradient: () => GRADIENT,
    createPattern: () => null,
    measureText: (text) => ({ width: String(text).length * 6 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
    setLineDash: () => {},
    getLineDash: () => [],
  };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      if (typeof property === 'symbol') return undefined;
      return () => undefined;
    },
    set(object, property, value) {
      object[property] = value;
      return true;
    },
    has() {
      return true;
    },
  });
}

/** Minimal canvas element satisfying the engine's feature checks. */
export function createFakeCanvas(width = 800, height = 600) {
  const context = createFakeContext();
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    getContext: () => context,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
  };
}

/** Deterministic clock + rAF queue for the perf governor. */
export function createFakeFrames(start = 0) {
  let time = start;
  let nextId = 1;
  const queue = [];
  const frames = {
    now: () => time,
    raf(callback) {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback });
      return id;
    },
    caf(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    /**
     * Advance the clock and execute exactly one queued rAF callback (if any).
     * Returns true when a callback ran.
     */
    step(ms) {
      time += ms;
      const item = queue.shift();
      if (!item) return false;
      item.callback(time);
      return true;
    },
    pending() {
      return queue.length;
    },
    get time() {
      return time;
    },
  };
  return frames;
}

/** Fake document supporting only visibilitychange listeners. */
export function createFakeDocument(hidden = false) {
  const listeners = new Map();
  return {
    hidden,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      const set = listeners.get(type);
      if (set) set.delete(callback);
    },
    dispatch(type) {
      const set = listeners.get(type);
      if (set) for (const callback of Array.from(set)) callback({ type });
    },
    listenerCount(type) {
      return listeners.get(type) ? listeners.get(type).size : 0;
    },
  };
}

/** Fake window good enough for createViewportWatcher. */
export function createFakeWindow({ width = 800, height = 600, dpr = 1 } = {}) {
  const listeners = new Map();
  return {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      const set = listeners.get(type);
      if (set) set.delete(callback);
    },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };
}

/** A valid SessionView fixture; override any field. */
export function sessionView(overrides = {}) {
  const now = Date.now();
  return {
    sessionId: 'claude-code:test-session',
    host: 'claude-code',
    hostVersion: '2.1.299',
    state: 'idle',
    reportedState: 'idle',
    source: 'host-native',
    confidence: 'confirmed',
    connected: true,
    lastEventAt: now,
    startedAt: now - 60_000,
    metrics: {},
    recentEvents: [],
    warnings: [],
    ...overrides,
  };
}
