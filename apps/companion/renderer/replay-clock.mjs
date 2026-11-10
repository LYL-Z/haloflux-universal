/**
 * F-10 replay virtual clock.
 *
 * LIVE uses the wall clock. REPLAY uses the event timestamp at the current
 * cursor; the statistics window must never use "today" for a historical run.
 */
export function replayNow({ replay, liveNow = Date.now() } = {}) {
  if (!replay || !Array.isArray(replay.events) || replay.events.length === 0) return liveNow;
  const index = Math.max(0, Math.min(replay.events.length - 1, Math.floor(Number(replay.index) || 0)));
  const timestamp = replay.events[index]?.timestamp;
  return Number.isFinite(timestamp) ? timestamp : liveNow;
}

export function replayWindow({ replay, liveNow = Date.now(), windowMs = 120_000 } = {}) {
  const now = replayNow({ replay, liveNow });
  return { now, from: now - Math.max(0, windowMs), to: now };
}
