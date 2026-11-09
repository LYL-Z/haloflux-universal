/**
 * HALOFLUX analytics engine.
 *
 * Every metric returns its formula, the exact input window and the evidence
 * class, so the UI can show "how was this number produced?" instead of asking
 * the user to trust a decorative graphic.
 *
 * Evidence classes (never collapsed):
 *   OBSERVED_NATIVE / PROVIDER_REPORTED / OBSERVED_SYSTEM / DERIVED / SIMULATED / UNKNOWN
 */
export const ANALYTICS_VERSION = '0.1.0';

export const EVIDENCE = Object.freeze({
  NATIVE: 'OBSERVED_NATIVE',
  PROVIDER: 'PROVIDER_REPORTED',
  SYSTEM: 'OBSERVED_SYSTEM',
  DERIVED: 'DERIVED',
  SIMULATED: 'SIMULATED',
  UNKNOWN: 'UNKNOWN',
});

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

/** P50/P95/P99 with sample count and the raw window. */
export function percentiles(values) {
  const clean = (Array.isArray(values) ? values : []).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    evidence: EVIDENCE.DERIVED,
    formula: 'nearest-rank linear interpolation over the observed sample',
  };
}

/** λ = N(Δt)/Δt over a fixed window; reports cache coverage explicitly. */
export function eventRate(events, { now = Date.now(), windowMs = 120000, buckets = 12, cacheLimit = 30 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const start = now - windowMs;
  const width = windowMs / Math.max(1, buckets);
  const counts = new Array(buckets).fill(0);
  let inWindow = 0;
  for (const event of list) {
    const ts = num(event?.timestamp);
    if (ts === null || ts < start || ts > now) continue;
    inWindow += 1;
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((ts - start) / width)));
    counts[index] += 1;
  }
  return {
    lambdaPerSecond: windowMs > 0 ? inWindow / (windowMs / 1000) : null,
    count: inWindow,
    windowMs,
    bucketMs: width,
    buckets: counts,
    cacheLimit,
    cached: list.length,
    cacheTruncated: list.length >= cacheLimit,
    evidence: EVIDENCE.DERIVED,
    formula: 'λ = N(Δt) / Δt',
    inputs: 'observed event timestamps inside the selected window (cache-limited)',
    limitation: `renderer cache holds at most ${cacheLimit} events; λ is a cache rate, not lifetime total`,
  };
}

/** Pair tool.start/end by session + run + call id; never cross-session. */
export function toolWaterfall(events) {
  const open = new Map();
  const rows = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.eventType !== 'string') continue;
    const callId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
    if (!callId) {
      if (event.eventType === 'tool.end' || event.eventType === 'tool.fail') {
        rows.push({ ...event, status: 'UNCORRELATED', durationMs: null });
      }
      continue;
    }
    const key = `${event.sessionId || ''}\u0000${event.runId || ''}\u0000${callId}`;
    if (event.eventType === 'tool.start') {
      if (!open.has(key)) open.set(key, event);
      continue;
    }
    if (event.eventType !== 'tool.end' && event.eventType !== 'tool.fail') continue;
    const start = open.get(key);
    if (start) open.delete(key);
    const duration = start ? (num(event.timestamp) ?? 0) - (num(start.timestamp) ?? 0) : null;
    rows.push({
      ...event,
      toolName: event.toolName || start?.toolName,
      durationMs: num(event.durationMs) ?? (start && duration !== null && duration >= 0 ? duration : null),
      status: start ? (event.eventType === 'tool.fail' ? 'FAILED' : 'COMPLETED') : 'UNCORRELATED',
      correlated: Boolean(start),
    });
  }
  return {
    rows,
    completed: rows.filter((row) => row.status === 'COMPLETED').length,
    failed: rows.filter((row) => row.status === 'FAILED').length,
    uncorrelated: rows.filter((row) => row.status === 'UNCORRELATED').length,
    evidence: EVIDENCE.DERIVED,
    formula: 'duration = t_end - t_start, keyed by sessionId + runId + toolCallId',
    limitation: 'only cached pairs are visible; unpaired events stay UNCORRELATED',
  };
}

/** Longest weighted path in a task DAG. Returns null on a cycle. */
export function criticalPath(tasks, { durationKey = 'durationMs' } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((task) => task && task.id);
  const byId = new Map(list.map((task) => [String(task.id), task]));
  const deps = new Map(list.map((task) => [String(task.id), Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []]));
  const memo = new Map();
  const visiting = new Set();
  const pathMemo = new Map();
  const longest = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) throw new Error(`cycle detected at ${id}`);
    visiting.add(id);
    let best = 0;
    let bestPath = [id];
    for (const dep of deps.get(id) || []) {
      if (!byId.has(dep)) continue;
      const candidate = longest(dep);
      if (candidate > best) { best = candidate; bestPath = [...(pathMemo.get(dep) || [dep]), id]; }
    }
    const own = Math.max(0, Number(byId.get(id)?.[durationKey]) || 0);
    memo.set(id, best + own);
    pathMemo.set(id, bestPath);
    visiting.delete(id);
    return memo.get(id);
  };
  try {
    let best = 0;
    let bestPath = [];
    for (const task of list) {
      const value = longest(String(task.id));
      if (value > best) { best = value; bestPath = pathMemo.get(String(task.id)) || []; }
    }
    return {
      durationMs: best,
      path: bestPath,
      nodeCount: list.length,
      evidence: EVIDENCE.DERIVED,
      formula: 'T_critical = max_path Σ(duration_i)',
      limitation: 'requires a complete, trusted dependency DAG; missing edges change the critical path',
    };
  } catch (error) {
    return { durationMs: null, path: [], nodeCount: list.length, error: error.message, evidence: EVIDENCE.DERIVED };
  }
}

/** Jain fairness index over comparable work units. */
export function jainIndex(values) {
  const xs = (Array.isArray(values) ? values : []).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  const sum = xs.reduce((a, b) => a + b, 0);
  const squares = xs.reduce((a, b) => a + b * b, 0);
  return {
    value: xs.length && squares > 0 ? (sum * sum) / (xs.length * squares) : null,
    n: xs.length,
    evidence: EVIDENCE.DERIVED,
    formula: 'J = (Σx_i)^2 / (n Σx_i^2)',
    limitation: 'x_i must be comparable (work items, not raw token counts mixed with tasks)',
  };
}

/** Little's law for a stable queue; refuses to claim stability from tiny samples. */
export function littleLaw({ arrivalRatePerSecond, waitMs, samples = 0, minimumSamples = 30 } = {}) {
  const lambda = num(arrivalRatePerSecond);
  const wait = num(waitMs);
  const settled = samples >= minimumSamples;
  return {
    queueLength: lambda !== null && wait !== null && settled ? lambda * (wait / 1000) : null,
    settled,
    samples,
    minimumSamples,
    evidence: EVIDENCE.DERIVED,
    formula: 'L = λW',
    limitation: 'only meaningful for a stable queue with enough samples; not a claim of stability',
  };
}

/** Shannon entropy in bits; null without a trustworthy distribution. */
export function shannonEntropy(probabilities) {
  const p = (Array.isArray(probabilities) ? probabilities : []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  const sum = p.reduce((a, b) => a + b, 0);
  if (!p.length || sum <= 0) {
    return { bits: null, evidence: EVIDENCE.UNKNOWN, formula: 'H(P) = -Σ p_i log2(p_i)', limitation: 'requires a real probability distribution (e.g. logprobs)' };
  }
  const normalized = p.map((v) => v / sum);
  return {
    bits: -normalized.reduce((acc, v) => acc + v * Math.log2(v), 0),
    n: p.length,
    evidence: EVIDENCE.DERIVED,
    formula: 'H(P) = -Σ p_i log2(p_i)',
    limitation: 'a normalized frequency is not a model probability unless the provider exposes one',
  };
}

/** Jensen-Shannon divergence (base 2) between two same-definition distributions. */
export function jsDivergence(pValues, qValues) {
  const p = (Array.isArray(pValues) ? pValues : []).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  const q = (Array.isArray(qValues) ? qValues : []).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  if (!p.length || p.length !== q.length) return { bits: null, evidence: EVIDENCE.UNKNOWN, limitation: 'equal-length, same-definition distributions required' };
  const sp = p.reduce((a, b) => a + b, 0);
  const sq = q.reduce((a, b) => a + b, 0);
  if (sp <= 0 || sq <= 0) return { bits: null, evidence: EVIDENCE.UNKNOWN };
  const pn = p.map((v) => v / sp);
  const qn = q.map((v) => v / sq);
  const kl = (a, m) => a.reduce((acc, v, i) => acc + (v > 0 && m[i] > 0 ? v * Math.log2(v / m[i]) : 0), 0);
  const m = pn.map((v, i) => (v + qn[i]) / 2);
  return {
    bits: 0.5 * kl(pn, m) + 0.5 * kl(qn, m),
    evidence: EVIDENCE.DERIVED,
    formula: 'JSD(P||Q) = ½KL(P||M) + ½KL(Q||M), M = (P+Q)/2',
    limitation: 'same definition and normalization required; not a causal distance',
  };
}

/** Empirical state transition matrix from observed consecutive states. */
export function stateTransitions(events) {
  const states = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event && typeof event.state === 'string') states.push(event.state);
  }
  const counts = {};
  let samples = 0;
  for (let i = 1; i < states.length; i += 1) {
    const from = states[i - 1];
    const to = states[i];
    if (!counts[from]) counts[from] = {};
    counts[from][to] = (counts[from][to] || 0) + 1;
    samples += 1;
  }
  const matrix = {};
  for (const [from, row] of Object.entries(counts)) {
    const total = Object.values(row).reduce((a, b) => a + b, 0);
    matrix[from] = Object.fromEntries(Object.entries(row).map(([to, n]) => [to, { count: n, probability: n / total }]));
  }
  return {
    matrix,
    samples,
    evidence: EVIDENCE.DERIVED,
    formula: 'P_ij = N_ij / Σ_k N_ik',
    limitation: 'consecutive events are not necessarily a complete Markov process; report sample size',
  };
}

export function contextUsage(used, limit) {
  const u = num(used);
  const l = num(limit);
  return {
    ratio: u !== null && l !== null && l > 0 ? u / l : null,
    used: u,
    limit: l,
    evidence: EVIDENCE.DERIVED,
    formula: 'C = tokens_used / context_limit',
    limitation: 'only valid when the host reports both counts with the same tokenizer/context definition',
  };
}

/** Registry consumed by the Evidence Inspector. */
export const METRIC_REGISTRY = Object.freeze({
  eventRate: {
    name: 'Event rate', formula: 'λ = N(Δt)/Δt', unit: 'events/s',
    inputs: 'event.timestamp', window: 'configurable (default 120 s)', evidence: EVIDENCE.DERIVED,
    limitation: 'cache-limited; not a lifetime total', visualization: 'Tool Event Rate',
  },
  percentiles: {
    name: 'Latency percentiles', formula: 'P50/P95/P99 of observed samples', unit: 'ms',
    inputs: 'durationMs', window: 'selected cache window', evidence: EVIDENCE.DERIVED,
    limitation: 'sample-size sensitive; report n', visualization: 'Tool Waterfall / Research panel',
  },
  criticalPath: {
    name: 'Critical path', formula: 'T = max_path Σ duration_i', unit: 'ms',
    inputs: 'task.dependsOn + durationMs', window: 'one trace/run', evidence: EVIDENCE.DERIVED,
    limitation: 'depends on a complete, trusted DAG', visualization: 'Execution DAG',
  },
  jainIndex: {
    name: 'Jain fairness', formula: 'J = (Σx_i)²/(nΣx_i²)', unit: '0..1',
    inputs: 'comparable work units', window: 'selected run', evidence: EVIDENCE.DERIVED,
    limitation: 'x_i definition must be fixed before comparison', visualization: 'Agent Dispatch',
  },
  littleLaw: {
    name: "Little's law", formula: 'L = λW', unit: 'tasks',
    inputs: 'arrival rate + wait time', window: 'stable interval', evidence: EVIDENCE.DERIVED,
    limitation: 'not valid for a transient queue; minimum sample applies', visualization: 'Research panel',
  },
  entropy: {
    name: 'Shannon entropy', formula: 'H(P) = -Σp_i log2(p_i)', unit: 'bits',
    inputs: 'provider-exposed distribution', window: 'one response', evidence: EVIDENCE.UNKNOWN,
    limitation: 'no logprobs => UNKNOWN, never synthesized', visualization: 'Model Inference Stream',
  },
  jsDivergence: {
    name: 'Jensen-Shannon divergence', formula: 'JSD(P||Q)', unit: 'bits',
    inputs: 'two same-definition distributions', window: 'two windows', evidence: EVIDENCE.DERIVED,
    limitation: 'requires comparable definitions', visualization: 'Trace comparison',
  },
  stateTransitions: {
    name: 'State transitions', formula: 'P_ij = N_ij/Σ_k N_ik', unit: 'probability',
    inputs: 'consecutive states', window: 'selected sessions', evidence: EVIDENCE.DERIVED,
    limitation: 'sample size and observation gaps must be shown', visualization: 'Failure & Recovery',
  },
  contextUsage: {
    name: 'Context usage', formula: 'C = used/limit', unit: 'ratio',
    inputs: 'host-reported token counts', window: 'current turn', evidence: EVIDENCE.DERIVED,
    limitation: 'same tokenizer/context definition required', visualization: 'Context / Memory',
  },
});
