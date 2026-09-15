/**
 * Shared SQLite access for the preview worker.
 *
 * The worker claims `preview_jobs` rows directly in the server's database
 * (WAL mode + busy_timeout make concurrent access safe) and writes finished
 * `reviews` rows. Schema mirrors packages/server/src/db.ts exactly.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const dataDir = resolve(process.env.VELLUM_DATA_DIR ?? "./.vellum-data");
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, "store.db");
export const artifactDir = join(dataDir, "artifacts");
mkdirSync(artifactDir, { recursive: true });

export const db: Database.Database = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Ensure the tables the worker touches exist (the server normally creates
// them; creating them identically here lets the worker run standalone).
db.exec(`
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

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
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

  CREATE INDEX IF NOT EXISTS idx_preview_jobs_status ON preview_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_reviews_lookup ON reviews(draftId, draftVersion, contentHash);
`);

// ---------------------------------------------------------------------------
// Row shapes (match server db.ts / @vellum/core protocol)
// ---------------------------------------------------------------------------

export interface PreviewJobRow {
  id: string;
  draftId: string;
  draftVersion: number;
  contentHash: string;
  profiles: string; // JSON string[]
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  reviewId: string | null;
  error: string | null;
  attempts: number;
}

export interface DraftRow {
  id: string;
  version: number;
  content: string; // JSON DesignContent
  updatedAt: number;
}

export interface DatasetRow {
  id: string;
  title: string;
  ownership: string;
  schema: string; // JSON DatasetSchema
  value: string; // JSON DatasetValue
  source: string | null;
  updatedAt: number;
  version: number;
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Atomically claim the oldest queued job. The UPDATE is guarded by
 * `status = 'queued'` so two workers can never claim the same row.
 */
export function claimNextJob(): PreviewJobRow | undefined {
  const now = Date.now();
  return db
    .prepare(
      `UPDATE preview_jobs
         SET status = 'running', startedAt = ?, attempts = attempts + 1
       WHERE status = 'queued'
         AND id = (SELECT id FROM preview_jobs WHERE status = 'queued' ORDER BY createdAt ASC, rowid ASC LIMIT 1)
       RETURNING *`
    )
    .get(now) as PreviewJobRow | undefined;
}

/** Release a running job back to the queue (graceful shutdown). */
export function releaseJobToQueued(jobId: string): void {
  db.prepare(
    "UPDATE preview_jobs SET status = 'queued', startedAt = NULL WHERE id = ? AND status = 'running'"
  ).run(jobId);
}

export function markJobDone(jobId: string, reviewId: string): void {
  db.prepare(
    "UPDATE preview_jobs SET status = 'done', reviewId = ?, finishedAt = ?, error = NULL WHERE id = ?"
  ).run(reviewId, Date.now(), jobId);
}

export function markJobFailed(jobId: string, error: string): void {
  db.prepare(
    "UPDATE preview_jobs SET status = 'failed', error = ?, finishedAt = ? WHERE id = ?"
  ).run(error.slice(0, 4000), Date.now(), jobId);
}

export function getDraft(draftId: string): DraftRow | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as DraftRow | undefined;
}

export function insertReview(review: {
  id: string;
  draftId: string;
  draftVersion: number;
  contentHash: string;
  rendererVersion: string;
  catalogueVersion: string;
  profiles: string[];
  diagnostics: unknown[];
  screenshots: unknown[];
  datasetSnapshots: Record<string, number>;
  status: string;
  createdAt: number;
}): void {
  db.prepare(
    `INSERT INTO reviews (id, draftId, draftVersion, contentHash, rendererVersion, catalogueVersion,
                          profiles, diagnostics, screenshots, datasetSnapshots, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    review.id,
    review.draftId,
    review.draftVersion,
    review.contentHash,
    review.rendererVersion,
    review.catalogueVersion,
    JSON.stringify(review.profiles),
    JSON.stringify(review.diagnostics),
    JSON.stringify(review.screenshots),
    JSON.stringify(review.datasetSnapshots),
    review.status,
    review.createdAt
  );
}

export function getDatasetsById(ids: string[]): DatasetRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(`SELECT * FROM datasets WHERE id IN (${placeholders})`)
    .all(...ids) as DatasetRow[];
}

/** Capability record the server reads back (e.g. whether a widget renderer is up). */
export function setMeta(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
