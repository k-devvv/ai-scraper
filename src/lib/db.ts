/**
 * src/lib/db.ts
 * SQLite persistence layer — stores all scrape/crawl results durably.
 *
 * Why SQLite:
 *   - Zero config (no external service needed)
 *   - File-based (works in Docker with a volume mount)
 *   - Fast enough for single-instance deployments
 *   - Upgrade to PostgreSQL later if needed (same schema)
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "output", "scraper.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // ── Schema ──────────────────────────────────────────────────────────────
  _db.exec(`
    CREATE TABLE IF NOT EXISTS results (
      id          TEXT PRIMARY KEY,
      job_id      TEXT NOT NULL,
      job_type    TEXT NOT NULL CHECK(job_type IN ('scrape','crawl','batch','sitemap','screenshot','map')),
      url         TEXT NOT NULL,
      schema_name TEXT,
      model       TEXT,
      mode        TEXT,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','error')),
      data        TEXT,
      error       TEXT,
      confidence  REAL,
      method      TEXT,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      fetch_ms    INTEGER DEFAULT 0,
      extract_ms  INTEGER DEFAULT 0,
      total_ms    INTEGER DEFAULT 0,
      truncated   INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_results_job_id ON results(job_id);
    CREATE INDEX IF NOT EXISTS idx_results_url ON results(url);
    CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at);

    CREATE TABLE IF NOT EXISTS screenshots (
      id          TEXT PRIMARY KEY,
      job_id      TEXT NOT NULL,
      url         TEXT NOT NULL,
      format      TEXT NOT NULL DEFAULT 'png',
      data        BLOB,
      width       INTEGER,
      height      INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_screenshots_job_id ON screenshots(job_id);
  `);

  return _db;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export interface ResultRow {
  id: string;
  job_id: string;
  job_type: string;
  url: string;
  schema_name: string | null;
  model: string | null;
  mode: string | null;
  status: string;
  data: string | null;
  error: string | null;
  confidence: number | null;
  method: string | null;
  input_tokens: number;
  output_tokens: number;
  fetch_ms: number;
  extract_ms: number;
  total_ms: number;
  truncated: number;
  created_at: string;
  updated_at: string;
}

const insertResult = () =>
  getDb().prepare(`
    INSERT INTO results (id, job_id, job_type, url, schema_name, model, mode, status, data, error, confidence, method, input_tokens, output_tokens, fetch_ms, extract_ms, total_ms, truncated)
    VALUES (@id, @job_id, @job_type, @url, @schema_name, @model, @mode, @status, @data, @error, @confidence, @method, @input_tokens, @output_tokens, @fetch_ms, @extract_ms, @total_ms, @truncated)
  `);

export function saveResult(row: Omit<ResultRow, "created_at" | "updated_at">): void {
  insertResult().run(row);
}

export function getResultsByJobId(jobId: string): ResultRow[] {
  return getDb()
    .prepare("SELECT * FROM results WHERE job_id = ? ORDER BY created_at")
    .all(jobId) as ResultRow[];
}

export function getResultsByUrl(url: string, limit = 10): ResultRow[] {
  return getDb()
    .prepare("SELECT * FROM results WHERE url = ? ORDER BY created_at DESC LIMIT ?")
    .all(url, limit) as ResultRow[];
}

export function getRecentResults(limit = 50): ResultRow[] {
  return getDb()
    .prepare("SELECT * FROM results ORDER BY created_at DESC LIMIT ?")
    .all(limit) as ResultRow[];
}

// ── Screenshots ───────────────────────────────────────────────────────────

export function saveScreenshot(row: {
  id: string;
  job_id: string;
  url: string;
  format: string;
  data: Buffer;
  width: number;
  height: number;
}): void {
  getDb()
    .prepare(
      "INSERT INTO screenshots (id, job_id, url, format, data, width, height) VALUES (@id, @job_id, @url, @format, @data, @width, @height)"
    )
    .run(row);
}

export function getScreenshot(id: string): { data: Buffer; format: string } | null {
  const row = getDb()
    .prepare("SELECT data, format FROM screenshots WHERE id = ?")
    .get(id) as { data: Buffer; format: string } | undefined;
  return row ?? null;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

export function purgeOlderThan(days: number): number {
  const result = getDb()
    .prepare("DELETE FROM results WHERE created_at < datetime('now', ?)")
    .run(`-${days} days`);
  return result.changes;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
