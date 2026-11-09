/**
 * Replay history paging + `at` parsing (P3.2.1).
 *
 * The bridge returns at most 1000 events per page. A long session must be read
 * with a stable snapshot boundary (`to`) and offset pages; otherwise events
 * appended during paging can duplicate/omit rows. If the caller's cap is hit,
 * the result is explicitly marked PARTIAL.
 */

export function parseReplayAt(raw) {
  if (raw === null || raw === undefined) return { present: false, valid: false, value: null };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { present: true, valid: false, value: null };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) return { present: true, valid: false, value: null };
  return { present: true, valid: true, value };
}

export async function collectReplayPages({
  fetchPage,
  pageSize = 1000,
  maxEvents = 20000,
  snapshotTo = Date.now(),
} = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const events = [];
  const seen = new Set();
  let offset = 0;
  let total = null;
  let pages = 0;
  let partial = false;
  for (;;) {
    const page = await fetchPage({ offset, limit: Math.max(1, Math.min(1000, pageSize)), to: snapshotTo });
    pages += 1;
    total = Number.isFinite(page.total) ? page.total : total;
    const batch = Array.isArray(page.events) ? page.events : [];
    for (const event of batch) {
      const id = event?.eventId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      events.push(event);
    }
    if (batch.length === 0) break;
    if (total !== null && events.length >= total) break;
    if (events.length >= maxEvents) { partial = true; break; }
    offset += batch.length;
  }
  events.sort((a, b) => (a.timestamp - b.timestamp) || String(a.eventId).localeCompare(String(b.eventId)));
  return {
    events,
    total: total === null ? events.length : total,
    loaded: events.length,
    pages,
    snapshotTo,
    partial: partial || (total !== null && events.length < total),
  };
}
