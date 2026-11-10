/**
 * P4.2-A: real event time arc.
 *
 * Pure mapping helpers shared by rendering and tests. An event's timestamp is
 * the only source of position; event order never implies causality.
 */
export function sortByTime(events) {
  return [...(Array.isArray(events) ? events : [])]
    .filter((event) => event && Number.isFinite(event.timestamp))
    .sort((a, b) => (a.timestamp - b.timestamp) || String(a.eventId || '').localeCompare(String(b.eventId || '')));
}

export function buildTimeArc(events, { bins = 256, now = 0, windowMs = 0, from = 0, to = 0 } = {}) {
  const list = sortByTime(events);
  let start = Number(from) || 0;
  let end = Number(to) || 0;
  if (!start || !end) {
    if (windowMs > 0) {
      end = Number(now) || (list.length ? list[list.length - 1].timestamp : 0);
      start = end - windowMs;
    } else if (list.length) {
      start = list[0].timestamp;
      end = list[list.length - 1].timestamp;
    }
  }
  const span = Math.max(1, end - start);
  const counts = new Uint32Array(Math.max(1, bins));
  const host = new Uint32Array(counts.length);
  const derived = new Uint32Array(counts.length);
  const simulated = new Uint32Array(counts.length);
  let visible = 0;
  let missingTimestamp = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!Number.isFinite(event?.timestamp)) { missingTimestamp += 1; continue; }
    if (event.timestamp < start || event.timestamp > end) continue;
    const bin = Math.min(counts.length - 1, Math.max(0, Math.floor(((event.timestamp - start) / span) * (counts.length - 1))));
    counts[bin] += 1;
    visible += 1;
    if (event.source === 'simulated') simulated[bin] += 1;
    else if (event.source === 'derived') derived[bin] += 1;
    else host[bin] += 1;
  }
  return { list, counts, host, derived, simulated, start, end, span, visible, missingTimestamp, bins: counts.length };
}

export function angleForTimestamp(timestamp, arc) {
  if (!arc || !Number.isFinite(timestamp)) return 0;
  const ratio = (timestamp - arc.start) / Math.max(1, arc.span);
  return Math.max(0, Math.min(1, ratio)) * Math.PI * 2;
}

export function timestampForRatio(ratio, arc) {
  if (!arc) return 0;
  return arc.start + Math.max(0, Math.min(1, ratio)) * arc.span;
}

/** Index of the visible event closest to the click time; -1 for empty. */
export function eventIndexAtTimestamp(arc, timestamp) {
  if (!arc?.list?.length) return -1;
  let lo = 0;
  let hi = arc.list.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arc.list[mid].timestamp <= timestamp) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const next = Math.min(arc.list.length - 1, best + 1);
  return Math.abs(arc.list[best].timestamp - timestamp) <= Math.abs(arc.list[next].timestamp - timestamp) ? best : next;
}
