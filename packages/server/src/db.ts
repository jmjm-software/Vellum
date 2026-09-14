import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const dataDir = process.env.VELLUM_DATA_DIR ?? join(_dirname, "..", "..", "..", ".vellum-data");
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, "store.db");
export const db: Database.Database = new Database(dbPath);
db.pragma("journal_mode = WAL");

export const artifactDir = join(dataDir, "artifacts");
mkdirSync(artifactDir, { recursive: true });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revisions (
    revision INTEGER PRIMARY KEY,
    draftId TEXT NOT NULL,
    draftVersion INTEGER NOT NULL,
    contentHash TEXT NOT NULL,
    content TEXT NOT NULL,
    reviewId TEXT,
    publishedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    ownership TEXT NOT NULL CHECK(ownership IN ('dashboard', 'mirrored')),
    schema TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT,
    updatedAt INTEGER NOT NULL,
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    datasetId TEXT,
    itemId TEXT,
    payload TEXT,
    idempotencyKey TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed', 'failed')),
    requiresHarness INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    claimedAt INTEGER,
    resolvedAt INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    lastError TEXT
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    draftId TEXT NOT NULL,
    draftVersion INTEGER NOT NULL,
    contentHash TEXT NOT NULL,
    rendererVersion TEXT NOT NULL,
    catalogueVersion TEXT NOT NULL,
    profiles TEXT NOT NULL,
    diagnostics TEXT NOT NULL,
    screenshots TEXT NOT NULL,
    datasetSnapshots TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('passed', 'passed_with_warnings', 'failed')),
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preview_jobs (
    id TEXT PRIMARY KEY,
    draftId TEXT NOT NULL,
    draftVersion INTEGER NOT NULL,
    contentHash TEXT NOT NULL,
    profiles TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed')),
    createdAt INTEGER NOT NULL,
    startedAt INTEGER,
    finishedAt INTEGER,
    reviewId TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    mimeType TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    result TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_preview_jobs_status ON preview_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
  CREATE INDEX IF NOT EXISTS idx_events_dedup ON events(datasetId, itemId, type, status);
  CREATE INDEX IF NOT EXISTS idx_reviews_lookup ON reviews(draftId, draftVersion, contentHash);
  CREATE INDEX IF NOT EXISTS idx_drafts_id ON drafts(id);
`);

// Ensure meta seed
const seedMeta = db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`);
seedMeta.run("current_revision", "0");
seedMeta.run("format_version", "1");

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
