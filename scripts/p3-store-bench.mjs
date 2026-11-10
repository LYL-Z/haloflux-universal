#!/usr/bin/env node
/**
 * P3.2.1 write-load benchmark: per-event append latency and event-loop delay.
 * Writes a temp HALOFLUX_HOME only; never touches the user's store.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import path from 'node:path';

import { createEvent } from '../packages/event-schema/dist/index.js';
import { EventStore } from '../packages/event-store/src/index.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'haloflux-bench-'));
const out = path.resolve(process.env.HALOFLUX_BENCH_OUT || 'tests/evidence/p3/store-bench.json');
const store = new EventStore({ home });
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const count = Number(process.env.HALOFLUX_BENCH_EVENTS || 3000);
const latencies = [];
const started = performance.now();
for (let i = 0; i < count; i += 1) {
  const event = createEvent({
    host: 'deepseek-harness', sessionId: 'bench-session', eventType: 'tool.start',
    timestamp: 1000 + i, metadata: { toolName: 'Bash', toolCallId: `call-${i}`, runId: 'bench-run' },
  });
  const t0 = performance.now();
  store.append(event);
  latencies.push(performance.now() - t0);
  if (i % 100 === 99) await new Promise((resolve) => setImmediate(resolve));
}
const totalMs = performance.now() - started;
loop.disable();
const sorted = [...latencies].sort((a, b) => a - b);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const result = {
  events: count,
  totalMs,
  eventsPerSecond: count / (totalMs / 1000),
  appendMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1) },
  eventLoopDelayMs: {
    mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6,
  },
  store: store.stats(),
  integrity: store.integrityCheck(),
  generatedAt: new Date().toISOString(),
  home,
};
store.close();
rmSync(home, { recursive: true, force: true });
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, home: undefined }, null, 2));
