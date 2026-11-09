/**
 * HALOFLUX local event store (P3.2-A).
 *
 * Why SQLite (node:sqlite, no dependency):
 *  - eventId PRIMARY KEY gives cheap, crash-safe dedupe;
 *  - WAL survives abnormal exits and supports one writer + readers;
 *  - indexes on session/run/trace/timestamp answer history queries without
 *    scanning every segment;
 *  - DELETE + PRAGMA secure_delete covers the "secure delete" requirement.
 * Segmented JSONL was the alternative; it is simpler to inspect but needs a
 * hand-built index and dedupe set, and secure deletion is unreliable. The
 * decision record lives in reports/p3/P3.2-A-EVENT-STORE.md.
 *
 * Only schema-validated events are stored. The schema already rejects unknown
 * metadata, prompts, tool arguments/results and credentials.
 */
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { validateEvent, SCHEMA_VERSION } from '../../event-schema/dist/index.js';

export const EVENT_STORE_VERSION = '0.1.0';
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_QUERY_LIMIT = 1000;

export function eventStorePath(home) {
  return path.join(home, 'events', 'haloflux-events.sqlite');
}

export class EventStore {
  constructor({ home, file = '', readonly = false } = {}) {
    this.home = home;
    this.file = file || eventStorePath(home);
    this.closed = false;
    this.readonly = readonly;
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file, { readOnly: readonly });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        trace_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, timestamp);
    `);
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, schema_version, timestamp, stored_at, host, session_id, run_id, trace_id, event_type, source, confidence, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.count = this.db.prepare('SELECT COUNT(*) AS n FROM events');
  }

  append(event) {
    if (this.closed) throw new Error('event store is closed');
    const result = validateEvent(event);
    if (!result.ok) throw new Error(`refusing invalid event: ${result.errors.map((e) => e.path).join(',')}`);
    const payload = JSON.stringify(event);
    const info = this.insert.run(
      event.eventId,
      event.schemaVersion,
      event.timestamp,
      Date.now(),
      event.host,
      event.sessionId,
      event.metadata?.runId || event.runId || null,
      event.traceId || null,
      event.eventType,
      event.source,
      event.confidence,
      payload,
    );
    return { inserted: Number(info.changes) > 0 };
  }

  appendMany(events) {
    const list = Array.isArray(events) ? events : [];
    let inserted = 0;
    let duplicates = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of list) {
        const result = this.append(event);
        if (result.inserted) inserted += 1;
        else duplicates += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
    return { inserted, duplicates, total: list.length };
  }

  query({ sessionId = '', runId = '', traceId = '', from = 0, to = 0, limit = 200, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
    if (runId) { where.push('run_id = ?'); args.push(runId); }
    if (traceId) { where.push('trace_id = ?'); args.push(traceId); }
    if (Number.isFinite(from) && from > 0) { where.push('timestamp >= ?'); args.push(from); }
    if (Number.isFinite(to) && to > 0) { where.push('timestamp <= ?'); args.push(to); }
    const cap = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(limit) || 200));
    const skip = Math.max(0, Number(offset) || 0);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT payload FROM events ${clause} ORDER BY timestamp ASC, event_id ASC LIMIT ? OFFSET ?`)
      .all(...args, cap, skip);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`).get(...args);
    return {
      events: rows.map((row) => JSON.parse(row.payload)),
      total: Number(totalRow?.n || 0),
      returned: rows.length,
      limit: cap,
      offset: skip,
      window: { from: from || null, to: to || null },
      schemaVersion: SCHEMA_VERSION,
    };
  }

  stats() {
    const row = this.db.prepare(`SELECT COUNT(*) AS n, MIN(timestamp) AS first, MAX(timestamp) AS last FROM events`).get();
    return {
      events: Number(row?.n || 0),
      firstTimestamp: row?.first ?? null,
      lastTimestamp: row?.last ?? null,
      file: this.file,
      sizeBytes: (() => {
        try {
          const base = existsSync(this.file) ? statSync(this.file).size : 0;
          const wal = existsSync(`${this.file}-wal`) ? statSync(`${this.file}-wal`).size : 0;
          return base + wal;
        } catch { return null; }
      })(),
    };
  }

  pruneBefore(timestamp) {
    const info = this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(timestamp);
    return { deleted: Number(info.changes || 0), before: timestamp };
  }

  deleteSession(sessionId) {
    const info = this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    return { deleted: Number(info.changes || 0), sessionId };
  }

  vacuum() {
    this.db.exec('VACUUM');
  }

  integrityCheck() {
    const rows = this.db.prepare('PRAGMA integrity_check').all();
    return rows.map((row) => row.integrity_check).join('; ');
  }

  exportJsonl(file) {
    const rows = this.db.prepare('SELECT payload FROM events ORDER BY timestamp ASC').all();
    const lines = rows.map((row) => row.payload).join('\n');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, lines ? `${lines}\n` : '');
    return { exported: rows.length, file };
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      try { this.db.close(); } catch { /* already closed */ }
    }
  }
}

export function openEventStore({ home, file = '', readonly = false } = {}) {
  return new EventStore({ home, file, readonly });
}
