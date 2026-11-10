#!/usr/bin/env node
/**
 * F-05 replay hot-path benchmark: prepare/index/seek at 652, 2500, 5000, 20000.
 * Synthetic events use the real event constructor and the same shape as stored
 * history; no sampling is removed to flatter the numbers.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createEvent } from '../packages/event-schema/dist/index.js';
import { prepareReplay, sessionAt } from '../apps/companion/renderer/replay-engine.mjs';

const counts = [652, 2500, 5000, 20000];
const out = path.resolve(process.env.HALOFLUX_REPLAY_BENCH_OUT || 'tests/evidence/p4/replay-bench.json');
const rows = [];
for (const count of counts) {
  const events = Array.from({ length: count }, (_, i) => createEvent({
    host: 'generic', sessionId: 'bench', eventType: i % 2 ? 'tool.end' : 'tool.start',
    timestamp: 1000 + i * 10, source: 'simulated', confidence: 'unverified',
    metadata: { toolName: 'Bash', toolCallId: `c-${Math.floor(i / 2)}`, runId: 'r', ...(i % 2 ? { durationMs: 7 } : {}) },
  }));
  const t0 = performance.now();
  const prepared = prepareReplay(events);
  const prepareMs = performance.now() - t0;
  const indexStart = performance.now();
  for (let i = 0; i < 2000; i += 1) prepared.indexAt((i / 2000) * prepared.durationMs, 1);
  const indexMs = performance.now() - indexStart;
  const seekStart = performance.now();
  for (let i = 0; i < 200; i += 1) prepared.sessionAtIndex(Math.floor((i / 200) * (count - 1)));
  const seekMs = performance.now() - seekStart;
  const naiveStart = performance.now();
  sessionAt(events, Math.floor(count / 2));
  const naiveOneMs = performance.now() - naiveStart;
  rows.push({
    events: count, prepareMs, index2000Ms: indexMs, seek200Ms: seekMs,
    naiveSessionAtMs: naiveOneMs,
    checkpoints: prepared.checkpoints.length,
    heapUsedMB: process.memoryUsage().heapUsed / 1048576,
    rssMB: process.memoryUsage().rss / 1048576,
  });
}
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
console.log(JSON.stringify({ out, rows }, null, 2));
