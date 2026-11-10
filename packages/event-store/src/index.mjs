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
    if (!readonly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA secure_delete = ON');
    }
    this.db.exec('PRAGMA busy_timeout = 3000');
    if (!readonly) {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        seq INTEGER,
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        trace_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, timestamp);
    `);
      const columns = this.db.prepare("PRAGMA table_info(events)").all().map((row) => row.name);
      if (!columns.includes('seq')) this.db.exec('ALTER TABLE events ADD COLUMN seq INTEGER');
      this.db.exec('UPDATE events SET seq = rowid WHERE seq IS NULL');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_seq ON events(seq)');
      const maxSeq = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get();
      this.db.prepare(`
        INSERT INTO meta(key, value) VALUES ('seq_highwater', ?)
        ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)
      `).run(Number(maxSeq?.n || 0));
      this.db.exec('PRAGMA user_version = 2');
    }
    this.getHighwater = this.db.prepare("SELECT value FROM meta WHERE key = 'seq_highwater'");
    this.setHighwater = this.db.prepare("UPDATE meta SET value = ? WHERE key = 'seq_highwater'");
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, schema_version, timestamp, stored_at, seq, host, session_id, run_id, trace_id, event_type, source, confidence, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.count = this.db.prepare('SELECT COUNT(*) AS n FROM events');
  }

  append(event) {
    if (this.closed) throw new Error('event store is closed');
    if (this.inTransaction) return this.#appendInTransaction(event);
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = this.#appendInTransaction(event);
      this.db.exec('COMMIT');
      this.inTransaction = false;
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      this.inTransaction = false;
      throw error;
    }
  }

  #appendInTransaction(event) {
    const result = validateEvent(event);
    if (!result.ok) throw new Error(`refusing invalid event: ${result.errors.map((e) => e.path).join(',')}`);
    const payload = JSON.stringify(event);
    // Persistent high-water mark: deleting the current maximum can never make
    // this value go backwards, so an old snapshot cannot observe new events.
    const current = this.getHighwater.get();
    const seq = Number(current?.value || 0) + 1;
    this.setHighwater.run(seq);
    const info = this.insert.run(
      event.eventId,
      event.schemaVersion,
      event.timestamp,
      Date.now(),
      seq,
      event.host,
      event.sessionId,
      event.metadata?.runId || event.runId || null,
      event.traceId || null,
      event.eventType,
      event.source,
      event.confidence,
      payload,
    );
    return { inserted: Number(info.changes) > 0, seq };
  }

  appendMany(events) {
    const list = Array.isArray(events) ? events : [];
    let inserted = 0;
    let duplicates = 0;
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      for (const event of list) {
        const result = this.#appendInTransaction(event);
        if (result.inserted) inserted += 1;
        else duplicates += 1;
      }
      this.db.exec('COMMIT');
      this.inTransaction = false;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      this.inTransaction = false;
      throw error;
    }
    return { inserted, duplicates, total: list.length };
  }

  snapshot({ sessionId = '', runId = '', traceId = '', from = 0, to = 0 } = {}) {
    const { clause, args } = this.#filter({ sessionId, runId, traceId, from, to });
    const row = this.db.prepare(`SELECT MAX(seq) AS maxSeq, COUNT(*) AS total FROM events ${clause}`).get(...args);
    return { snapshotSeq: Number(row?.maxSeq || 0), total: Number(row?.n || row?.total || 0) };
  }

  #filter({ sessionId = '', runId = '', traceId = '', from = 0, to = 0 } = {}) {
    const where = [];
    const args = [];
    if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
    if (runId) { where.push('run_id = ?'); args.push(runId); }
    if (traceId) { where.push('trace_id = ?'); args.push(traceId); }
    if (Number.isFinite(from) && from > 0) { where.push('timestamp >= ?'); args.push(from); }
    if (Number.isFinite(to) && to > 0) { where.push('timestamp <= ?'); args.push(to); }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  query({
    sessionId = '', runId = '', traceId = '', from = 0, to = 0,
    limit = 200, offset = 0, snapshotSeq = 0, afterSeq = null,
  } = {}) {
    const { clause, args } = this.#filter({ sessionId, runId, traceId, from, to });
    const cap = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(limit) || 200));
    const skip = Math.max(0, Number(offset) || 0);
    let snapshot = Number(snapshotSeq) || 0;
    if (!snapshot) {
      const row = this.db.prepare(`SELECT MAX(seq) AS maxSeq FROM events ${clause}`).get(...args);
      snapshot = Number(row?.maxSeq || 0);
    }
    const pageWhere = clause ? `${clause} AND seq <= ?` : 'WHERE seq <= ?';
    const pageArgs = [...args, snapshot];
    const cursorMode = afterSeq !== null && afterSeq !== undefined;
    let rows;
    let totalRow;
    if (cursorMode) {
      const cursor = Math.max(0, Number(afterSeq) || 0);
      rows = this.db.prepare(`SELECT seq, payload FROM events ${pageWhere} AND seq > ? ORDER BY seq ASC LIMIT ?`)
        .all(...pageArgs, cursor, cap);
      totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM events ${pageWhere}`).get(...pageArgs);
    } else {
      rows = this.db.prepare(`SELECT seq, payload FROM events ${pageWhere} ORDER BY timestamp ASC, event_id ASC LIMIT ? OFFSET ?`)
        .all(...pageArgs, cap, skip);
      totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM events ${pageWhere}`).get(...pageArgs);
    }
    return {
      events: rows.map((row) => JSON.parse(row.payload)),
      total: Number(totalRow?.n || 0),
      returned: rows.length,
      limit: cap,
      offset: cursorMode ? null : skip,
      snapshotSeq: snapshot,
      nextCursor: rows.length ? Number(rows[rows.length - 1].seq) : null,
      cursorMode,
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

  deleteEvent(eventId) {
    const info = this.db.prepare('DELETE FROM events WHERE event_id = ?').run(eventId);
    return { deleted: Number(info.changes || 0), eventId };
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
