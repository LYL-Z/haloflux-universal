/**
 * Event fixtures built with the real validator constructor from
 * packages/event-schema/dist/index.js, so every fixture is contract-valid by
 * construction unless a test deliberately mutates it.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROOT } from './env.mjs';

const schemaUrl = pathToFileURL(path.join(ROOT, 'packages', 'event-schema', 'dist', 'index.js')).href;
export const schema = await import(schemaUrl);
export const { createEvent, validateEvent, EVENT_DEFAULT_STATE, MAX_BATCH } = schema;

let seq = 0;

/** Build one valid event. */
export function event(host, sessionId, eventType, overrides = {}) {
  seq += 1;
  return createEvent({
    host,
    sessionId,
    eventType,
    hostVersion: overrides.hostVersion ?? 'test-1.0',
    timestamp: overrides.timestamp ?? Date.now() + seq,
    eventId: overrides.eventId ?? `evt-${host}-${Date.now().toString(36)}-${seq}`,
    ...overrides,
  });
}

/**
 * The canonical loop from task-5: session.start → task.received → run.start →
 * tool.start → tool.fail → approval.request → run.end.
 * Timestamps are strictly increasing so the session manager applies in order.
 */
export function agentLoop({ host = 'generic', sessionId = 'sess-e2e', start = Date.now(), stepMs = 20 } = {}) {
  const types = [
    'session.start',
    'task.received',
    'run.start',
    'tool.start',
    'tool.fail',
    'approval.request',
    'run.end',
  ];
  return types.map((eventType, index) => {
    const metadata = {};
    if (eventType === 'tool.start' || eventType === 'tool.fail') metadata.toolName = 'Read';
    if (eventType === 'tool.fail') metadata.errorCode = 'E_TOOL';
    if (eventType === 'approval.request') metadata.approvalKind = 'shell';
    if (eventType === 'task.received') metadata.projectName = 'haloflux-test';
    if (eventType === 'run.end') metadata.durationMs = 1234;
    return event(host, sessionId, eventType, {
      timestamp: start + index * stepMs,
      metadata,
    });
  });
}

/** Batch of `count` valid heartbeat events for load / batch tests. */
export function batchOf(count, { host = 'generic', sessionId = 'sess-batch' } = {}) {
  if (count > MAX_BATCH) throw new Error(`batchOf: contract max is ${MAX_BATCH}`);
  return Array.from({ length: count }, (_, index) =>
    event(host, sessionId, 'session.heartbeat', {
      timestamp: Date.now() + index,
      metadata: { step: index },
    }),
  );
}
