/**
 * P4.2-D: event beams.
 *
 * Only observed event types create pulses. Model-request/TTFT/reasoning are not
 * event types in HALOFLUX v1 and can never create a pulse here.
 */
const BEAM_TYPES = {
  'tool.start': { direction: 'out', weight: 1.0 },
  'tool.end': { direction: 'in', weight: 0.65 },
  'tool.fail': { direction: 'fail', weight: 1.0 },
  'tool.retry': { direction: 'retry', weight: 0.8 },
  'error': { direction: 'fail', weight: 0.9 },
};

export function beamKindForEvent(event) {
  if (!event || typeof event.eventType !== 'string' || !event.eventId) return null;
  return BEAM_TYPES[event.eventType] ? { type: event.eventType, ...BEAM_TYPES[event.eventType] } : null;
}

export function createBeamState({ max = 48, minGapMs = 35 } = {}) {
  const seen = new Set();
  const pulses = [];
  let lastAt = 0;
  return {
    pulses,
    seen,
    ingest(events, now = Date.now()) {
      let added = 0;
      const list = Array.isArray(events) ? events : [];
      for (const event of list) {
        const id = event?.eventId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 5000) {
          const oldest = seen.values().next().value;
          seen.delete(oldest);
        }
        const kind = beamKindForEvent(event);
        if (!kind) continue;
        if (now - lastAt < minGapMs && pulses.length) continue;
        lastAt = now;
        pulses.push({
          eventId: id, type: kind.type, direction: kind.direction, weight: kind.weight,
          source: event.source || 'unknown', confidence: event.confidence || 'unknown',
          startedAt: now,
        });
        added += 1;
      }
      while (pulses.length > max) pulses.shift();
      return added;
    },
    active(now = Date.now(), lifeMs = 1400) {
      return pulses.filter((pulse) => now - pulse.startedAt <= lifeMs);
    },
  };
}

export function pulseOpacity(pulse, now = Date.now(), lifeMs = 1400) {
  if (!pulse) return 0;
  const age = Math.max(0, now - pulse.startedAt);
  if (age > lifeMs) return 0;
  return (1 - age / lifeMs) * Math.max(0.2, pulse.weight);
}
