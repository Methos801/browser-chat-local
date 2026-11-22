/**
 * AppDb: the app's persistence layer — SQLite via sql.js (WASM).
 *
 * sql.js is an *in-memory* SQLite: the database lives in a WASM heap, so
 * persistence is our job. AppDb:
 *   - open(): loads <dbPath> if it exists (sql.js accepts raw SQLite file
 *     bytes directly), creates a fresh database otherwise, applies schema.
 *   - every write marks the db dirty and schedules a debounced export
 *     (default 250 ms) — an atomic write (tmp file + rename), so a crash
 *     can never leave a half-written file.
 *   - close(): final flush, so the last write of a session survives.
 *
 * The file lives in Electron's per-app userData dir (main.ts passes the
 * path). This class never touches Electron APIs, so the smoke test can
 * drive it against a plain temp file.
 *
 * Why sql.js over better-sqlite3: pure WASM — no native compile step, so
 * packaging (electron-builder) just ships the npm module and unpacks the
 * .wasm from the asar (see package.json "build").
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from "sql.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  protocol    TEXT NOT NULL,
  auth        TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL,
  position        INTEGER NOT NULL,
  role            TEXT NOT NULL,
  json            TEXT NOT NULL,
  PRIMARY KEY (conversation_id, position)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, position);
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL
);
-- Skill enable/config state (per-family presets land here in a later pass).
CREATE TABLE IF NOT EXISTS skills (
  name        TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config_json TEXT
);
`;

export interface AppDbOptions {
  /** Debounce before a dirty db is written to disk (ms). Default 250. */
  saveDelayMs?: number;
}

export class AppDb {
  private sql: SqlJsStatic | null = null;
  private db: SqlDatabase | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    private readonly dbPath: string,
    private readonly opts: AppDbOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Load (or create) the database and apply the schema. */
  async open(): Promise<this> {
    if (this.db) return this;
    // require.resolve works in the CJS main process; the "./dist/*" subpath
    // is in sql.js's exports map. Electron's fs patch (plus asarUnpack in
    // package.json "build") makes the read work inside the packaged app.
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    this.sql = SQL;
    const file = existsSync(this.dbPath) ? readFileSync(this.dbPath) : null;
    // Copy the bytes: the WASM heap owns its own memory afterwards.
    this.db = file && file.length ? new SQL.Database(new Uint8Array(file)) : new SQL.Database();
    this.db.exec(SCHEMA);
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);
    this.markDirty();
    return this;
  }

  transaction(fn: () => void): void {
    this.requireDb().run("BEGIN");
    try { fn(); this.requireDb().run("COMMIT"); }
    catch (err) { this.requireDb().run("ROLLBACK"); throw err; }
  }

  /** Execute a write statement; returns rows changed. */
  run(sql: string, params: unknown[] = []): number {
    const db = this.requireDb();
    db.run(sql, params);
    this.markDirty();
    return db.getRowsModified();
  }

  /** First row of a query as an object, or undefined. */
  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    const st = this.requireDb().prepare(sql);
    try {
      st.bind(params);
      return st.step() ? (st.getAsObject() as T) : undefined;
    } finally {
      st.free();
    }
  }

  /** All rows of a query as objects. */
  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const st = this.requireDb().prepare(sql);
    const out: T[] = [];
    try {
      st.bind(params);
      while (st.step()) out.push(st.getAsObject() as T);
      return out;
    } finally {
      st.free();
    }
  }

  /** Write the in-memory db to disk (atomic: tmp + rename). No-op if clean. */
  async flush(): Promise<void> {
    const db = this.db;
    if (!db || !this.dirty) return;
    const bytes = db.export();
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, this.dbPath);
    this.dirty = false;
  }

  /** Flush pending changes and release the WASM database. */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.db?.close();
    this.db = null;
    this.sql = null;
    this.dirty = false;
  }

  /* ------------------------------ internals ---------------------------- */

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    const delay = this.opts.saveDelayMs ?? 250;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) =>
        console.error("[db] save failed:", err?.message ?? err),
      );
    }, delay);
  }

  private requireDb(): SqlDatabase {
    if (!this.db) throw new Error("AppDb is not open (call open() first)");
    return this.db;
  }
}
