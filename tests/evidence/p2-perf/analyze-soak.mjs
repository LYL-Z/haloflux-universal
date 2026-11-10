#!/usr/bin/env node
/**
 * Analyze a soak report produced by scripts/soak.mjs and emit a compact JSON
 * summary (duration, events, RSS/CPU trend, GC dips, postErrors, leak signal).
 *
 * Usage: node tests/evidence/p2-perf/analyze-soak.mjs [path-to-soak.json]
 * Writes: <soak dir>/soak-30min-analysis.json  (never modifies the raw report)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2] || path.join(HERE, 'soak-30min.json');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const samples = Array.isArray(report.samples) ? report.samples : [];
const MB = 1024 * 1024;

if (samples.length === 0) {
  console.error(`no samples in ${input}`);
  process.exit(2);
}

const first = samples[0];
const last = samples[samples.length - 1];
const durationMs = last.elapsedMs - first.elapsedMs;
const durationMin = durationMs / 60000;
const rss = samples.map((s) => (typeof s.bridgeRssBytes === 'number' ? s.bridgeRssBytes / MB : null)).filter((v) => v !== null);
const cpu = samples.map((s) => s.bridgeCpuPercent).filter((v) => typeof v === 'number');
const sortedRss = [...rss].sort((a, b) => a - b);
const median = sortedRss[Math.floor(sortedRss.length / 2)];
const mean = rss.reduce((a, b) => a + b, 0) / rss.length;

// GC dips: a sample-to-sample RSS drop larger than 1 MB means the heap shrank.
let gcDips = 0;
let largestDipMB = 0;
for (let i = 1; i < rss.length; i += 1) {
  const delta = rss[i - 1] - rss[i];
  if (delta > 1) {
    gcDips += 1;
    largestDipMB = Math.max(largestDipMB, delta);
  }
}

// Trend: least-squares slope of RSS over the last 15 minutes (MB/min).
const tail = samples.filter((s) => s.elapsedMs >= durationMs - 15 * 60 * 1000 && typeof s.bridgeRssBytes === 'number');
let slopeLast15MBPerMin = null;
if (tail.length >= 3) {
  const xs = tail.map((s) => s.elapsedMs / 60000);
  const ys = tail.map((s) => s.bridgeRssBytes / MB);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  slopeLast15MBPerMin = Number((((n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)) || 0).toFixed(3));
}

// Per-5-minute marks for the report table.
const marks = [];
for (let minute = 5; minute <= Math.floor(durationMin); minute += 5) {
  const target = minute * 60000;
  const sample = samples.reduce((best, cur) => (Math.abs(cur.elapsedMs - target) < Math.abs(best.elapsedMs - target) ? cur : best), samples[0]);
  marks.push({
    minute,
    eventCount: sample.eventCount,
    sessions: sample.sessions,
    rssMB: sample.bridgeRssBytes ? Number((sample.bridgeRssBytes / MB).toFixed(2)) : null,
    cpuPercent: sample.bridgeCpuPercent,
  });
}

const summary = {
  source: path.basename(input),
  status: report.status,
  startedAt: report.startedAt,
  finishedAt: report.finishedAt ?? null,
  requestedMinutes: report.durationMinutes,
  actualDurationMinutes: Number(durationMin.toFixed(2)),
  actualDurationSeconds: Number((durationMs / 1000).toFixed(1)),
  eventsPerSecondRequested: report.eventsPerSecond,
  observedEventsPerSecond: Number((last.eventCount / (durationMs / 1000)).toFixed(2)),
  samples: samples.length,
  sampleEveryMs: samples.length > 1 ? Math.round((last.elapsedMs - first.elapsedMs) / (samples.length - 1)) : null,
  sent: last.sent,
  accepted: last.accepted,
  postErrors: last.postErrors ?? null,
  dropped: last.dropped ?? null,
  duplicates: last.duplicates ?? null,
  finalEventCount: last.eventCount,
  finalSessions: last.sessions,
  rss: {
    firstMB: Number((first.bridgeRssBytes / MB).toFixed(2)),
    lastMB: Number((last.bridgeRssBytes / MB).toFixed(2)),
    minMB: Number(Math.min(...rss).toFixed(2)),
    maxMB: Number(Math.max(...rss).toFixed(2)),
    meanMB: Number(mean.toFixed(2)),
    medianMB: Number(median.toFixed(2)),
    growthMB: Number((last.bridgeRssBytes / MB - first.bridgeRssBytes / MB).toFixed(2)),
    growthMBPerMin: Number(((last.bridgeRssBytes / MB - first.bridgeRssBytes / MB) / durationMin).toFixed(3)),
    gcDips,
    largestDipMB: Number(largestDipMB.toFixed(2)),
    slopeLast15MBPerMin,
  },
  cpu: {
    samples: cpu.length,
    meanPercent: Number((cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(3)),
    maxPercent: Number(Math.max(...cpu).toFixed(3)),
    nonzeroSamples: cpu.filter((v) => v > 0).length,
  },
  marks,
  leakSignal:
    slopeLast15MBPerMin !== null && slopeLast15MBPerMin < 0.05 && gcDips > 0
      ? 'PLATEAU_WITH_GC (no monotonic growth in the last 15 min)'
      : slopeLast15MBPerMin !== null && slopeLast15MBPerMin >= 0.05
        ? 'GROWING (needs longer soak before calling it a leak)'
        : 'INSUFFICIENT_SAMPLES',
};

const outPath = path.join(path.dirname(input), 'soak-30min-analysis.json');
fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
console.log(`\n[analysis] wrote ${outPath}`);
