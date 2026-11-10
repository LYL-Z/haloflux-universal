#!/usr/bin/env node
/**
 * Aggregate a Chrome/DevTools trace without guessing which stage is hot.
 * Input is the gzip written by scripts/p4-trace-app.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const input = path.resolve(process.argv[2] || 'tests/evidence/p4/trace-2500-play.json.gz');
const out = path.resolve(process.argv[3] || 'tests/evidence/p4/trace-2500-play-analysis.json');
const raw = JSON.parse(gunzipSync(readFileSync(input)).toString());
const events = Array.isArray(raw.traceEvents) ? raw.traceEvents : [];
const groups = {
  JS: /^(FunctionCall|EvaluateScript|CompileScript|v8\.compile|v8\.run|RunTask|Program)$/,
  Layout: /^(Layout|UpdateLayoutTree|ScheduleStyleRecalculation|RecalculateStyles)$/,
  Paint: /^(Paint|PaintImage|DrawFrame|RasterTask|Layerize|PrePaint|PaintSetup|PaintCommit)$/,
  Composite: /^(CompositeLayers|Commit|ActivateLayerTree|UpdateLayer|BeginFrame|DrawLayers|SwapBuffers)$/,
  GC: /^(MinorGC|MajorGC|BlinkGC|GCEvent|Heap\.GC|CppGC.*)$/,
  GPU: /^(GPUTask|GpuTask|Graphics\.Pipeline|RendererFrame|DisplayCompositor)$/,
};
const totals = new Map();
const byGroup = Object.fromEntries(Object.keys(groups).map((key) => [key, { us: 0, count: 0, maxUs: 0, names: new Map() }]));
let complete = 0;
let totalUs = 0;
for (const event of events) {
  if (event.ph !== 'X' || !Number.isFinite(event.dur) || event.dur <= 0) continue;
  complete += 1;
  totalUs += event.dur;
  const item = totals.get(event.name) || { name: event.name, cat: event.cat || '', us: 0, count: 0, maxUs: 0 };
  item.us += event.dur;
  item.count += 1;
  item.maxUs = Math.max(item.maxUs, event.dur);
  totals.set(event.name, item);
  for (const [group, pattern] of Object.entries(groups)) {
    if (!pattern.test(event.name)) continue;
    const bucket = byGroup[group];
    bucket.us += event.dur;
    bucket.count += 1;
    bucket.maxUs = Math.max(bucket.maxUs, event.dur);
    const entry = bucket.names.get(event.name) || { name: event.name, us: 0, count: 0 };
    entry.us += event.dur;
    entry.count += 1;
    bucket.names.set(event.name, entry);
  }
}
const groupRows = Object.entries(byGroup).map(([group, value]) => ({
  group, ms: value.us / 1000, count: value.count, maxMs: value.maxUs / 1000,
  top: [...value.names.values()].sort((a, b) => b.us - a.us).slice(0, 6).map((n) => ({ name: n.name, ms: n.us / 1000, count: n.count })),
}));
const top = [...totals.values()].sort((a, b) => b.us - a.us).slice(0, 30).map((item) => ({
  name: item.name, cat: item.cat, ms: item.us / 1000, count: item.count, maxMs: item.maxUs / 1000,
}));

// Per-thread attribution: summing every thread's overlapping durations is
// meaningless. Attribute JS/Layout/Paint to CrRendererMain and GPU calls to
// CrGpuMain separately.
const threadNames = new Map();
for (const event of events) {
  if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name || '');
}
function summarizeThread(label) {
  const entries = [...threadNames.entries()].filter(([, name]) => name === label);
  return entries.map(([key]) => {
    const list = events.filter((event) => event.ph === 'X' && Number.isFinite(event.dur) && event.dur > 0 && `${event.pid}:${event.tid}` === key);
    if (!list.length) return null;
    const start = Math.min(...list.map((event) => event.ts));
    const end = Math.max(...list.map((event) => event.ts + event.dur));
    const sums = new Map();
    const groupTotals = Object.fromEntries(Object.keys(groups).map((group) => [group, 0]));
    for (const event of list) {
      sums.set(event.name, (sums.get(event.name) || 0) + event.dur);
      for (const [group, pattern] of Object.entries(groups)) if (pattern.test(event.name)) groupTotals[group] += event.dur;
    }
    return {
      thread: key, label, events: list.length, spanMs: (end - start) / 1000,
      busyMs: list.reduce((sum, event) => sum + event.dur, 0) / 1000,
      groups: Object.fromEntries(Object.entries(groupTotals).map(([group, us]) => [group, us / 1000])),
      top: [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, us]) => ({ name, ms: us / 1000 })),
    };
  }).filter(Boolean);
}
const result = {
  input, traceEvents: events.length, completeEvents: complete, completeMs: totalUs / 1000,
  windowSeconds: raw.metadata?.seconds,
  metadata: raw.metadata || null,
  groupRows, top,
  threads: {
    rendererMain: summarizeThread('CrRendererMain'),
    gpuMain: summarizeThread('CrGpuMain'),
    compositor: summarizeThread('Compositor'),
  },
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ out, traceEvents: events.length, completeEvents: complete, threads: result.threads, top: top.slice(0, 12) }, null, 2));
