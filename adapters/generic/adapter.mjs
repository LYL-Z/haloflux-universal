#!/usr/bin/env node
/**
 * HALOFLUX adapter — generic stdin JSONL (future hosts, small scripts, tests).
 *
 * Accepts newline-delimited JSON on stdin or from `--file <path>`. Two shapes:
 *
 * 1. A complete HALOFLUX v1 event (validated with the frozen schema, then POSTed
 *    as-is). Use this when a host-side script already speaks the contract.
 * 2. A shorthand object:
 *      {"eventType":"tool.start","state":"tool","sessionId":"s1",
 *       "toolName":"Bash","label":"…"}
 *    Unknown fields are ignored; metadata is filtered through the allowlist, so
 *    a caller cannot smuggle prompt text into an event.
 *
 * Options:
 *   --host <hostId>    host id for shorthand events (default: generic)
 *   --file <path>      read the JSONL file instead of stdin
 *
 * Always prints a one-line summary and exits 0.
 */
import {
  parseJsonLines, postEvents, makeEvent, validateEvent, toSessionId, fallbackSessionId,
  readHostVersion, readStdinText, EVENT_TYPES, AGENT_STATES, safeString, safeNumber, safeToken,
} from '../_shared/event-client.mjs';
import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const host = safeString(argValue('host', 'generic'), 32) || 'generic';
const hostVersion = readHostVersion(host) || safeString(process.env.HALOFLUX_HOST_VERSION, 64) || '';
const file = argValue('file', '');

function toEvents(records) {
  const events = [];
  let skipped = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') { skipped += 1; continue; }
    const direct = validateEvent(record);
    if (direct.ok) { events.push(record); continue; }
    const eventType = safeString(record.eventType, 64);
    if (!eventType || !EVENT_TYPES.includes(eventType)) { skipped += 1; continue; }
    const state = typeof record.state === 'string' && AGENT_STATES.includes(record.state) ? record.state : undefined;
    const sessionId = toSessionId(record.sessionId, fallbackSessionId(host, 'generic-jsonl'));
    const event = makeEvent({
      host,
      hostVersion,
      sessionId,
      eventType,
      state,
      source: record.source === 'simulated' || record.source === 'derived' ? record.source : 'derived',
      confidence: ['confirmed', 'inferred', 'unverified'].includes(record.confidence) ? record.confidence : 'inferred',
      metadata: {
        toolName: record.toolName,
        toolCategory: record.toolCategory,
        label: record.label,
        errorCode: safeToken(record.errorCode, 64),
        durationMs: safeNumber(record.durationMs),
        tokenCount: safeNumber(record.tokenCount),
        model: record.model,
        sessionTitle: record.sessionTitle,
        agentName: record.agentName,
        custom: record.custom,
      },
    });
    if (event) events.push(event); else skipped += 1;
  }
  return { events, skipped };
}

let raw = '';
try {
  raw = file
    ? (existsSync(file) ? readFileSync(file, 'utf8') : '')
    : await readStdinText({ timeoutMs: 1500 });
} catch {
  raw = '';
}
const records = parseJsonLines(raw);
const { events, skipped } = toEvents(records);
const result = events.length ? await postEvents(events) : { ok: false, reason: 'no-events' };
process.stdout.write(`[generic-adapter] records=${records.length} events=${events.length} skipped=${skipped} posted=${result.ok}${result.reason ? ` reason=${result.reason}` : ''}\n`);
process.exit(0);
