import { db, getMeta, setMeta, artifactDir } from "./db.js";
import {
  validateDesign,
  validateDatasetValue,
  applyPatches,
  emptyValue,
  collectIds,
} from "@vellum/core/validate.js";
import { contentHash } from "@vellum/core/hash.js";
import { catalogueDescription } from "@vellum/core/catalog.js";
import {
  FORMAT_VERSION,
  CATALOGUE_VERSION,
  RENDERER_VERSION,
  PREVIEW_PROFILES,
  AUTHORING_GUIDANCE,
  DATA_LIMITS,
} from "@vellum/core";
import type {
  ContextArgs,
  ContextResult,
  EditArgs,
  EditResult,
  PreviewArgs,
  PreviewResult,
  PublishArgs,
  PublishResult,
  DataArgs,
  DataResult,
  AssetArgs,
  AssetResult,
  EventsArgs,
  EventsResult,
  SubmitActionRequest,
  SubmitActionResult,
  PreviewJob,
  DatasetSummary,
} from "@vellum/core/protocol.js";
import type {
  DashboardState,
  Dataset,
  DatasetDefinition,
  DatasetValue,
  DesignContent,
  Diagnostic,
  ErrorCode,
  Publication,
  ReviewRecord,
  ActionStatus,
  ActionEvent,
  AssetInfo,
} from "@vellum/core/types.js";
import { ASSET_LIMITS } from "@vellum/core/types.js";
import { sseManager } from "./sse.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Asset helpers (§10)
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  mimeType: string;
  bytes: number;
  filename: string | null;
  createdAt: number;
}

function toAssetInfo(row: AssetRow): AssetInfo {
  return {
    id: row.id,
    mimeType: row.mimeType,
    bytes: row.bytes,
    filename: row.filename ?? undefined,
    createdAt: row.createdAt,
    url: `/api/assets/${row.id}`,
  };
}

/** Magic-byte check: the declared mime type must match the actual payload. */
function matchesMagic(buf: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "image/jpeg":
      return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/gif":
      return buf.length > 6 && buf.subarray(0, 3).toString("ascii") === "GIF";
    case "image/webp":
      return (
        buf.length > 12 &&
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
      );
    default:
      return false;
  }
}

class AppError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

function parseDataset(row: { id: string; title: string; ownership: string; schema: string; value: string; source: string | null; updatedAt: number; version: number }): Dataset {
  return {
    id: row.id,
    title: row.title,
    ownership: row.ownership as Dataset["ownership"],
    schema: JSON.parse(row.schema) as Dataset["schema"],
    value: JSON.parse(row.value) as DatasetValue,
    source: row.source ?? undefined,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function serializeDataset(ds: Dataset): Record<string, unknown> {
  return {
    id: ds.id,
    title: ds.title,
    ownership: ds.ownership,
    schema: JSON.stringify(ds.schema),
    value: JSON.stringify(ds.value),
    source: ds.source ?? null,
    updatedAt: ds.updatedAt,
    version: ds.version,
  };
}

function datasetFacts(ds: Dataset): Record<string, number | string> {
  switch (ds.value.kind) {
    case "list":
      return {
        itemCount: ds.value.items.length,
        unchecked: ds.value.items.filter((i) => !i.done).length,
      };
    case "metric":
      return { fieldCount: Object.keys(ds.value.values).length };
    case "timeseries":
      return { sampleCount: ds.value.samples.length };
    case "records":
      return { rowCount: ds.value.rows.length };
  }
}

function toDatasetSummary(ds: Dataset): DatasetSummary {
  return {
    id: ds.id,
    title: ds.title,
    ownership: ds.ownership,
    schemaKind: ds.schema.kind,
    version: ds.version,
    updatedAt: ds.updatedAt,
    facts: datasetFacts(ds),
  };
}

function parsePublication(row: { revision: number; draftId: string; draftVersion: number; contentHash: string; content: string; reviewId: string | null; publishedAt: number }): Publication {
  return {
    revision: row.revision,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    contentHash: row.contentHash,
    content: JSON.parse(row.content) as DesignContent,
    reviewId: row.reviewId ?? "",
    publishedAt: row.publishedAt,
  };
}

function parseReview(row: {
  id: string;
  draftId: string;
  draftVersion: number;
  contentHash: string;
  rendererVersion: string;
  catalogueVersion: string;
  profiles: string;
  diagnostics: string;
  screenshots: string;
  datasetSnapshots: string;
  status: string;
  createdAt: number;
}): ReviewRecord {
  return {
    id: row.id,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    contentHash: row.contentHash,
    rendererVersion: row.rendererVersion,
    catalogueVersion: row.catalogueVersion,
    profiles: JSON.parse(row.profiles) as string[],
    diagnostics: JSON.parse(row.diagnostics) as Diagnostic[],
    screenshots: JSON.parse(row.screenshots) as ReviewRecord["screenshots"],
    datasetSnapshots: JSON.parse(row.datasetSnapshots) as Record<string, number>,
    status: row.status as ReviewRecord["status"],
    createdAt: row.createdAt,
  };
}

function parsePreviewJob(row: {
  id: string;
  draftId: string;
  draftVersion: number;
  contentHash: string;
  profiles: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  reviewId: string | null;
  error: string | null;
  attempts: number;
}): PreviewJob {
  return {
    id: row.id,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    contentHash: row.contentHash,
    profiles: JSON.parse(row.profiles) as string[],
    status: row.status as PreviewJob["status"],
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    reviewId: row.reviewId ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
  };
}

function blankDesign(): DesignContent {
  return {
    formatVersion: FORMAT_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    root: { id: "root", type: "grid", props: { columns: 12 }, children: [] },
    datasets: [],
    intent: { purpose: "Empty dashboard" },
  };
}

export class AppService {
  private knownDatasets(): Set<string> {
    const rows = db.prepare("SELECT id FROM datasets").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  private datasetSchemas(): Record<string, Dataset["schema"]> {
    const rows = db.prepare("SELECT id, schema FROM datasets").all() as { id: string; schema: string }[];
    const out: Record<string, Dataset["schema"]> = {};
    for (const r of rows) out[r.id] = JSON.parse(r.schema);
    return out;
  }

  private knownAssets(): Set<string> {
    const rows = db.prepare("SELECT id FROM assets").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  private getAllDatasets(): Dataset[] {
    const rows = db.prepare("SELECT * FROM datasets").all() as {
      id: string;
      title: string;
      ownership: string;
      schema: string;
      value: string;
      source: string | null;
      updatedAt: number;
      version: number;
    }[];
    return rows.map(parseDataset);
  }

  private getCurrentPublication(): Publication | null {
    const currentRev = Number(getMeta("current_revision") ?? "0");
    if (currentRev <= 0) return null;
    const row = db.prepare("SELECT * FROM revisions WHERE revision = ?").get(currentRev) as
      | {
          revision: number;
          draftId: string;
          draftVersion: number;
          contentHash: string;
          content: string;
          reviewId: string | null;
          publishedAt: number;
        }
      | undefined;
    if (!row) return null;
    return parsePublication(row);
  }

  getContext(args: ContextArgs): ContextResult {
    const pub = this.getCurrentPublication();
    const draftRow = db.prepare("SELECT id, version, updatedAt, content FROM drafts ORDER BY updatedAt DESC LIMIT 1").get() as
      | { id: string; version: number; updatedAt: number; content: string }
      | undefined;

    const datasets = this.getAllDatasets().map(toDatasetSummary);

    return {
      published: pub
        ? {
            revision: pub.revision,
            contentHash: pub.contentHash,
            publishedAt: pub.publishedAt,
            content: args.includeDesign !== false ? pub.content : undefined,
          }
        : null,
      draft: draftRow
        ? {
            id: draftRow.id,
            version: draftRow.version,
            updatedAt: draftRow.updatedAt,
            content: args.includeDesign !== false ? (JSON.parse(draftRow.content) as DesignContent) : undefined,
          }
        : null,
      datasets,
      targets: PREVIEW_PROFILES.map((p) => ({ kind: p.target, supported: true })),
      capabilities: {
        preview: true,
        // Whether a native widget renderer is attached to the preview worker:
        // determines if a widget design will get a visual review before publish.
        widget: getMeta("widget_renderer") === "available",
        continuousMode: false,
      },
      guidance: AUTHORING_GUIDANCE,
      catalogue: catalogueDescription(),
      versions: { format: FORMAT_VERSION, catalogue: CATALOGUE_VERSION, renderer: RENDERER_VERSION },
    };
  }

  edit(args: EditArgs): EditResult {
    const now = Date.now();
    const known = this.knownDatasets();
    const schemas = this.datasetSchemas();

    let draft: { id: string; version: number; content: DesignContent; updatedAt: number } | null = null;

    if (args.draftId) {
      const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(args.draftId) as
        | { id: string; version: number; content: string; updatedAt: number }
        | undefined;
      if (!row) throw new AppError("not_found", `Draft "${args.draftId}" not found`);
      if (args.expectedVersion !== undefined && row.version !== args.expectedVersion) {
        throw new AppError("precondition_failed", `Draft version mismatch: expected ${args.expectedVersion}, got ${row.version}`);
      }
      draft = { id: row.id, version: row.version, content: JSON.parse(row.content) as DesignContent, updatedAt: row.updatedAt };
    } else {
      const baseDesign: DesignContent =
        args.base === "blank"
          ? blankDesign()
          : (this.getCurrentPublication()?.content ?? blankDesign());
      draft = { id: genId("draft"), version: 1, content: baseDesign, updatedAt: now };
    }

    let nextContent: DesignContent;
    try {
      if (args.patches && args.patches.length > 0) {
        nextContent = applyPatches(draft.content, args.patches);
      } else if (args.content) {
        nextContent = args.content;
      } else {
        nextContent = draft.content;
      }
    } catch (err) {
      // Structural patch errors (unknown id, non-container parent) are client errors.
      throw new AppError("validation_failed", err instanceof Error ? err.message : String(err));
    }

    const validation = validateDesign(nextContent, { knownDatasets: known, datasetSchemas: schemas, knownAssets: this.knownAssets() });
    const nextVersion = draft.version + 1;

    db.prepare(
      "INSERT OR REPLACE INTO drafts (id, version, content, updatedAt) VALUES (?, ?, ?, ?)"
    ).run(draft.id, nextVersion, JSON.stringify(nextContent), now);

    return {
      draftId: draft.id,
      version: nextVersion,
      diagnostics: validation.diagnostics,
      valid: validation.content !== null,
      nextStep: validation.content !== null ? "preview this draft version" : "fix validation errors before preview",
    };
  }

  requestPreview(args: PreviewArgs): PreviewResult {
    const draftRow = db.prepare("SELECT * FROM drafts WHERE id = ?").get(args.draftId) as
      | { id: string; version: number; content: string }
      | undefined;
    if (!draftRow) throw new AppError("not_found", `Draft "${args.draftId}" not found`);

    const targetVersion = args.draftVersion ?? draftRow.version;
    if (targetVersion !== draftRow.version) {
      throw new AppError("precondition_failed", `Draft version mismatch: requested ${targetVersion}, current ${draftRow.version}`);
    }

    const content = JSON.parse(draftRow.content) as DesignContent;
    const invalid = validateDesign(content, { knownDatasets: this.knownDatasets(), datasetSchemas: this.datasetSchemas(), knownAssets: this.knownAssets() });
    if (invalid.content === null) {
      throw new AppError(
        "validation_failed",
        `Draft design is invalid: ${invalid.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`
      );
    }
    const hash = contentHash(content);
    const profiles = args.profiles ?? PREVIEW_PROFILES.map((p) => p.name);

    // Check existing finished review for exact match
    const reviewRow = db
      .prepare("SELECT * FROM reviews WHERE draftId = ? AND draftVersion = ? AND contentHash = ?")
      .get(draftRow.id, draftRow.version, hash) as { id: string } | undefined;
    if (reviewRow) {
      const review = parseReview(
        db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewRow.id) as Parameters<typeof parseReview>[0]
      );
      return {
        jobId: "reviewed",
        status: "done",
        review,
      };
    }

    // Check existing job
    const jobRow = db
      .prepare("SELECT * FROM preview_jobs WHERE draftId = ? AND draftVersion = ? AND contentHash = ? AND status IN ('queued', 'running')")
      .get(draftRow.id, draftRow.version, hash) as Parameters<typeof parsePreviewJob>[0] | undefined;
    if (jobRow) {
      return { jobId: parsePreviewJob(jobRow).id, status: parsePreviewJob(jobRow).status };
    }

    const jobId = genId("preview");
    db.prepare(
      "INSERT INTO preview_jobs (id, draftId, draftVersion, contentHash, profiles, status, createdAt, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(jobId, draftRow.id, draftRow.version, hash, JSON.stringify(profiles), "queued", Date.now(), 0);

    return { jobId, status: "queued" };
  }

  getPreviewJob(jobId: string): PreviewResult {
    const row = db.prepare("SELECT * FROM preview_jobs WHERE id = ?").get(jobId) as Parameters<typeof parsePreviewJob>[0] | undefined;
    if (!row) throw new AppError("not_found", `Preview job "${jobId}" not found`);
    const job = parsePreviewJob(row);

    if (job.status === "done" && job.reviewId) {
      const reviewRow = db.prepare("SELECT * FROM reviews WHERE id = ?").get(job.reviewId) as Parameters<typeof parseReview>[0] | undefined;
      if (reviewRow) {
        const review = parseReview(reviewRow);
        return { jobId, status: "done", review };
      }
    }

    return { jobId, status: job.status, error: job.error };
  }

  publish(args: PublishArgs): PublishResult {
    const now = Date.now();
    const idemRow = db.prepare("SELECT * FROM idempotency WHERE key = ? AND scope = 'publish'").get(args.idempotencyKey) as
      | { result: string; createdAt: number }
      | undefined;

    if (idemRow && idemRow.createdAt > now - 24 * 60 * 60 * 1000) {
      const cached = JSON.parse(idemRow.result) as PublishResult;
      return cached;
    }

    const draftRow = db.prepare("SELECT * FROM drafts WHERE id = ?").get(args.draftId) as
      | { id: string; version: number; content: string }
      | undefined;
    if (!draftRow) throw new AppError("not_found", `Draft "${args.draftId}" not found`);

    const content = JSON.parse(draftRow.content) as DesignContent;
    // Defense in depth: never publish an invalid design even if a review exists.
    const invalid = validateDesign(content, { knownDatasets: this.knownDatasets(), datasetSchemas: this.datasetSchemas(), knownAssets: this.knownAssets() });
    if (invalid.content === null) {
      throw new AppError("validation_failed", "Draft design is invalid; repair it and re-review before publishing");
    }
    const hash = contentHash(content);

    const reviewRow = db.prepare("SELECT * FROM reviews WHERE id = ?").get(args.reviewId) as Parameters<typeof parseReview>[0] | undefined;
    if (!reviewRow) throw new AppError("not_found", `Review "${args.reviewId}" not found`);
    const review = parseReview(reviewRow);

    if (review.draftId !== args.draftId || review.draftVersion !== draftRow.version || review.contentHash !== hash) {
      throw new AppError("stale_review", "Review does not match current draft content");
    }
    if (review.status === "failed") {
      throw new AppError("validation_failed", "Review status is failed");
    }
    if (review.diagnostics.some((d) => d.severity === "error")) {
      throw new AppError("validation_failed", "Review contains blocking error diagnostics");
    }

    const currentPub = this.getCurrentPublication();
    if (args.expectedPublishedRevision !== (currentPub?.revision ?? null)) {
      throw new AppError("precondition_failed", `Expected published revision ${args.expectedPublishedRevision}, but current is ${currentPub?.revision ?? "none"}`);
    }

    // Verify all referenced datasets exist
    const known = this.knownDatasets();
    for (const dsId of content.datasets) {
      if (!known.has(dsId)) {
        throw new AppError("validation_failed", `Design references unknown dataset "${dsId}"`);
      }
    }

    const currentRev = Number(getMeta("current_revision") ?? "0");
    const nextRev = currentRev + 1;
    const publishedAt = now;

    const publishTx = db.transaction(() => {
      db.prepare(
        "INSERT INTO revisions (revision, draftId, draftVersion, contentHash, content, reviewId, publishedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(nextRev, draftRow.id, draftRow.version, hash, JSON.stringify(content), review.id, publishedAt);
      setMeta("current_revision", String(nextRev));
      db.prepare("INSERT OR REPLACE INTO idempotency (key, scope, result, createdAt) VALUES (?, ?, ?, ?)").run(
        args.idempotencyKey,
        "publish",
        JSON.stringify({ publication: { revision: nextRev, draftId: draftRow.id, draftVersion: draftRow.version, contentHash: hash, content, reviewId: review.id, publishedAt }, datasetChecks: [] }),
        now
      );
    });
    publishTx();

    const publication: Publication = {
      revision: nextRev,
      draftId: draftRow.id,
      draftVersion: draftRow.version,
      contentHash: hash,
      content,
      reviewId: review.id,
      publishedAt,
    };

    sseManager.broadcast("publication", { revision: nextRev, publishedAt });

    return {
      publication,
      datasetChecks: content.datasets.map((id) => ({ datasetId: id, compatible: true })),
    };
  }

  data(args: DataArgs): DataResult {
    const now = Date.now();

    switch (args.op) {
      case "list": {
        const datasets = this.getAllDatasets().map(toDatasetSummary);
        return { op: "list", datasets };
      }
      case "get": {
        const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(args.datasetId) as Parameters<typeof parseDataset>[0] | undefined;
        if (!row) throw new AppError("not_found", `Dataset "${args.datasetId}" not found`);
        return { op: "get", dataset: parseDataset(row) };
      }
      case "create": {
        const def = args.definition;
        const value = args.value ?? emptyValue(def.schema);
        const validation = validateDatasetValue(def.schema, value);
        if (validation.errors.length > 0) {
          throw new AppError("validation_failed", validation.errors.join("; "));
        }
        const ds: Dataset = { ...def, value: validation.value!, updatedAt: now, version: 1 };
        db.prepare(
          "INSERT INTO datasets (id, title, ownership, schema, value, source, updatedAt, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(ds.id, ds.title, ds.ownership, JSON.stringify(ds.schema), JSON.stringify(ds.value), ds.source ?? null, now, 1);
        sseManager.broadcast("dataset", { id: ds.id, version: ds.version });
        return { op: "create", dataset: ds };
      }
      case "update": {
        const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(args.datasetId) as Parameters<typeof parseDataset>[0] | undefined;
        if (!row) throw new AppError("not_found", `Dataset "${args.datasetId}" not found`);
        const ds = parseDataset(row);
        if (args.expectedVersion !== undefined && ds.version !== args.expectedVersion) {
          throw new AppError("precondition_failed", `Dataset version mismatch: expected ${args.expectedVersion}, got ${ds.version}`);
        }
        const validation = validateDatasetValue(ds.schema, args.value);
        if (validation.errors.length > 0) {
          throw new AppError("validation_failed", validation.errors.join("; "));
        }
        const nextVersion = ds.version + 1;
        db.prepare("UPDATE datasets SET value = ?, version = ?, updatedAt = ? WHERE id = ?").run(
          JSON.stringify(validation.value!),
          nextVersion,
          now,
          args.datasetId
        );
        sseManager.broadcast("dataset", { id: args.datasetId, version: nextVersion });
        return { op: "update", dataset: { ...ds, value: validation.value!, version: nextVersion, updatedAt: now } };
      }
      case "patchItem": {
        const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(args.datasetId) as Parameters<typeof parseDataset>[0] | undefined;
        if (!row) throw new AppError("not_found", `Dataset "${args.datasetId}" not found`);
        const ds = parseDataset(row);
        if (ds.schema.kind !== "list" || ds.value.kind !== "list") {
          throw new AppError("validation_failed", "patchItem only supported on list datasets");
        }
        if (args.expectedVersion !== undefined && ds.version !== args.expectedVersion) {
          throw new AppError("precondition_failed", `Dataset version mismatch: expected ${args.expectedVersion}, got ${ds.version}`);
        }
        const item = ds.value.items.find((i) => i.id === args.itemId);
        if (!item) throw new AppError("not_found", `Item "${args.itemId}" not found in dataset "${args.datasetId}"`);

        if (args.patch.label !== undefined) item.label = args.patch.label;
        if (args.patch.done !== undefined) item.done = args.patch.done;

        // Validate after patch
        const validation = validateDatasetValue(ds.schema, ds.value);
        if (validation.errors.length > 0) {
          throw new AppError("validation_failed", validation.errors.join("; "));
        }

        if (ds.ownership === "dashboard") {
          const nextVersion = ds.version + 1;
          db.prepare("UPDATE datasets SET value = ?, version = ?, updatedAt = ? WHERE id = ?").run(
            JSON.stringify(validation.value!),
            nextVersion,
            now,
            args.datasetId
          );
          sseManager.broadcast("dataset", { id: args.datasetId, version: nextVersion });
          const updatedDs = { ...ds, value: validation.value!, version: nextVersion, updatedAt: now };
          // No event needed for direct apply? But the spec says dashboard-owned actions create completed events.
          // patchItem through data op is different from clientAction. It doesn't create an event.
          return { op: "patchItem", dataset: updatedDs };
        } else {
          // Mirrored: create pending harness event
          const event: ActionEvent = {
            id: genId("event"),
            type: "patchItem",
            datasetId: args.datasetId,
            itemId: args.itemId,
            payload: { patch: args.patch },
            idempotencyKey: undefined,
            status: "pending",
            requiresHarness: true,
            createdAt: now,
            attempts: 0,
          };
          db.prepare(
            "INSERT INTO events (id, type, datasetId, itemId, payload, status, requiresHarness, createdAt, attempts, idempotencyKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(event.id, event.type, event.datasetId ?? null, event.itemId ?? null, JSON.stringify(event.payload), event.status, event.requiresHarness ? 1 : 0, now, 0, null);
          sseManager.broadcast("action", { id: event.id, status: event.status });
          return { op: "patchItem", dataset: ds, action: event };
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Assets (§10: uploaded, access-controlled; arbitrary remote URLs rejected)
  // -------------------------------------------------------------------------

  assets(args: AssetArgs): AssetResult {
    switch (args.op) {
      case "list": {
        const rows = db
          .prepare("SELECT id, mimeType, length(data) AS bytes, filename, createdAt FROM assets ORDER BY createdAt DESC")
          .all() as AssetRow[];
        return { op: "list", assets: rows.map(toAssetInfo) };
      }
      case "get": {
        const row = this.getAssetRow(args.assetId);
        return { op: "get", asset: toAssetInfo(row) };
      }
      case "upload": {
        const mime = String(args.mimeType ?? "").trim().toLowerCase();
        if (!(ASSET_LIMITS.mimeTypes as readonly string[]).includes(mime)) {
          throw new AppError(
            "validation_failed",
            `Unsupported mime type "${mime || "(missing)"}". Allowed: ${ASSET_LIMITS.mimeTypes.join(", ")}`
          );
        }
        const raw = String(args.dataBase64 ?? "").replace(/\s+/g, "");
        if (raw.length === 0) throw new AppError("validation_failed", "dataBase64 is required");
        if (raw.length > Math.ceil((ASSET_LIMITS.maxBytes * 4) / 3) + 1024) {
          throw new AppError("validation_failed", `Asset exceeds ${ASSET_LIMITS.maxBytes} bytes`);
        }
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
          throw new AppError("validation_failed", "dataBase64 is not valid base64");
        }
        const buf = Buffer.from(raw, "base64");
        if (buf.length === 0) throw new AppError("validation_failed", "asset payload is empty");
        if (buf.length > ASSET_LIMITS.maxBytes) {
          throw new AppError("validation_failed", `Asset exceeds ${ASSET_LIMITS.maxBytes} bytes`);
        }
        // The declared type must match the payload: no polyglot uploads.
        if (!matchesMagic(buf, mime)) {
          throw new AppError("validation_failed", `Payload does not look like ${mime}`);
        }
        const id = genId("asset");
        const now = Date.now();
        const filename = typeof args.filename === "string" ? args.filename.slice(0, 200) : null;
        db.prepare("INSERT INTO assets (id, data, mimeType, filename, createdAt) VALUES (?, ?, ?, ?, ?)").run(
          id,
          buf,
          mime,
          filename,
          now
        );
        return {
          op: "upload",
          asset: toAssetInfo({ id, mimeType: mime, bytes: buf.length, filename, createdAt: now }),
          nextStep: `Reference it from an image component: { op: "updateProps", id: "<image component id>", props: { assetId: "${id}", alt: "..." } } (image props: assetId, alt?, fit?, optional action such as { kind: "openUrl", href }), then dashboard_preview this draft version before publishing.`,
        };
      }
      case "delete": {
        const res = db.prepare("DELETE FROM assets WHERE id = ?").run(args.assetId);
        return { op: "delete", assetId: args.assetId, deleted: res.changes > 0 };
      }
    }
  }

  private getAssetRow(assetId: string): AssetRow {
    const row = db
      .prepare("SELECT id, mimeType, length(data) AS bytes, filename, createdAt FROM assets WHERE id = ?")
      .get(assetId) as AssetRow | undefined;
    if (!row) throw new AppError("not_found", `Asset "${assetId}" not found`);
    return row;
  }

  events(args: EventsArgs): EventsResult {
    const now = Date.now();
    switch (args.op) {
      case "list": {
        let sql = "SELECT * FROM events";
        const params: (string | number)[] = [];
        if (args.status) {
          sql += " WHERE status = ?";
          params.push(args.status);
        }
        sql += " ORDER BY createdAt DESC";
        if (args.limit) {
          sql += " LIMIT ?";
          params.push(args.limit);
        }
        const rows = db.prepare(sql).all(...params) as Parameters<typeof parseEventRow>[0][];
        return { op: "list", events: rows.map(parseEventRow) };
      }
      case "claim": {
        const max = args.max ?? 10;
        const claimant = args.claimant ?? "worker";
        const rows = db
          .prepare("SELECT * FROM events WHERE status = 'pending' ORDER BY createdAt ASC LIMIT ?")
          .all(max) as Parameters<typeof parseEventRow>[0][];
        const claimed: ActionEvent[] = [];
        for (const row of rows) {
          db.prepare("UPDATE events SET status = 'claimed', claimedAt = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'")
            .run(now, row.id);
          const updated = db.prepare("SELECT * FROM events WHERE id = ?").get(row.id) as Parameters<typeof parseEventRow>[0];
          claimed.push(parseEventRow(updated));
        }
        return { op: "claim", events: claimed };
      }
      case "ack": {
        const row = db.prepare("SELECT * FROM events WHERE id = ?").get(args.eventId) as Parameters<typeof parseEventRow>[0] | undefined;
        if (!row) throw new AppError("not_found", `Event "${args.eventId}" not found`);
        const nextStatus: ActionStatus = args.outcome === "success" ? "completed" : "failed";
        db.prepare("UPDATE events SET status = ?, resolvedAt = ?, lastError = ? WHERE id = ?").run(
          nextStatus,
          now,
          args.error ?? null,
          args.eventId
        );

        if (args.patch && row.datasetId) {
          const dsRow = db.prepare("SELECT * FROM datasets WHERE id = ?").get(row.datasetId) as Parameters<typeof parseDataset>[0] | undefined;
          if (dsRow) {
            const ds = parseDataset(dsRow);
            if (ds.schema.kind === "list" && ds.value.kind === "list") {
              const item = ds.value.items.find((i) => i.id === (args.patch!.itemId ?? row.itemId));
              if (item) {
                if (args.patch.label !== undefined) item.label = args.patch.label;
                if (args.patch.done !== undefined) item.done = args.patch.done;
                const validation = validateDatasetValue(ds.schema, ds.value);
                if (validation.errors.length === 0) {
                  const nextVersion = ds.version + 1;
                  db.prepare("UPDATE datasets SET value = ?, version = ?, updatedAt = ? WHERE id = ?").run(
                    JSON.stringify(validation.value!),
                    nextVersion,
                    now,
                    row.datasetId
                  );
                  sseManager.broadcast("dataset", { id: row.datasetId, version: nextVersion });
                }
              }
            }
          }
        }

        const updated = db.prepare("SELECT * FROM events WHERE id = ?").get(args.eventId) as Parameters<typeof parseEventRow>[0];
        const event = parseEventRow(updated);
        sseManager.broadcast("action", { id: event.id, status: event.status });
        return { op: "ack", event };
      }
      case "submit": {
        if (args.idempotencyKey) {
          const existing = db
            .prepare("SELECT id FROM events WHERE idempotencyKey = ?")
            .get(args.idempotencyKey) as { id: string } | undefined;
          if (existing) {
            const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(existing.id) as Parameters<typeof parseEventRow>[0];
            return { op: "submit", event: parseEventRow(ev) };
          }
        }
        // Dedupe on (datasetId, itemId, type) while pending
        if (args.datasetId) {
          const dup = db
            .prepare("SELECT * FROM events WHERE datasetId = ? AND itemId = ? AND type = ? AND status = 'pending'")
            .get(args.datasetId, args.itemId ?? null, args.type) as Parameters<typeof parseEventRow>[0] | undefined;
          if (dup) {
            return { op: "submit", event: parseEventRow(dup) };
          }
        }
        const event: ActionEvent = {
          id: genId("event"),
          type: args.type,
          datasetId: args.datasetId,
          itemId: args.itemId,
          payload: args.payload,
          idempotencyKey: args.idempotencyKey,
          status: "pending",
          requiresHarness: true,
          createdAt: now,
          attempts: 0,
        };
        db.prepare(
          "INSERT INTO events (id, type, datasetId, itemId, payload, status, requiresHarness, createdAt, attempts, idempotencyKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          event.id,
          event.type,
          event.datasetId ?? null,
          event.itemId ?? null,
          JSON.stringify(event.payload ?? null),
          event.status,
          event.requiresHarness ? 1 : 0,
          now,
          0,
          event.idempotencyKey ?? null
        );
        sseManager.broadcast("action", { id: event.id, status: event.status });
        return { op: "submit", event };
      }
    }
  }

  clientAction(req: SubmitActionRequest): SubmitActionResult {
    const now = Date.now();

    // Dedupe on idempotencyKey: replaying a client action must not double-apply.
    if (req.idempotencyKey) {
      const existingRow = db.prepare("SELECT * FROM events WHERE idempotencyKey = ?").get(req.idempotencyKey) as
        | Parameters<typeof parseEventRow>[0]
        | undefined;
      if (existingRow) {
        const dataset = req.datasetId ? this.getDataset(req.datasetId) ?? undefined : undefined;
        return { event: parseEventRow(existingRow), dataset };
      }
    }

    const dsRow = req.datasetId
      ? (db.prepare("SELECT * FROM datasets WHERE id = ?").get(req.datasetId) as Parameters<typeof parseDataset>[0] | undefined)
      : undefined;
    const ds = dsRow ? parseDataset(dsRow) : null;

    if (req.type === "toggleItem" && ds && ds.ownership === "dashboard" && ds.schema.kind === "list" && ds.value.kind === "list") {
      const item = ds.value.items.find((i) => i.id === req.itemId);
      if (item) {
        item.done = !item.done;
        const validation = validateDatasetValue(ds.schema, ds.value);
        if (validation.errors.length > 0) {
          throw new AppError("validation_failed", validation.errors.join("; "));
        }
        const nextVersion = ds.version + 1;
        db.prepare("UPDATE datasets SET value = ?, version = ?, updatedAt = ? WHERE id = ?").run(
          JSON.stringify(validation.value!),
          nextVersion,
          now,
          req.datasetId
        );
        sseManager.broadcast("dataset", { id: req.datasetId, version: nextVersion });
        const updatedDs = { ...ds, value: validation.value!, version: nextVersion, updatedAt: now };
        const event: ActionEvent = {
          id: genId("event"),
          type: req.type,
          datasetId: req.datasetId,
          itemId: req.itemId,
          payload: req.payload,
          idempotencyKey: req.idempotencyKey,
          status: "completed",
          requiresHarness: false,
          createdAt: now,
          attempts: 0,
        };
        db.prepare(
          "INSERT INTO events (id, type, datasetId, itemId, payload, status, requiresHarness, createdAt, attempts, idempotencyKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          event.id,
          event.type,
          event.datasetId ?? null,
          event.itemId ?? null,
          JSON.stringify(event.payload ?? null),
          event.status,
          event.requiresHarness ? 1 : 0,
          now,
          0,
          event.idempotencyKey ?? null
        );
        sseManager.broadcast("action", { id: event.id, status: event.status });
        return { event, dataset: updatedDs };
      }
    }

    // Fallback: create pending event
    const event: ActionEvent = {
      id: genId("event"),
      type: req.type,
      datasetId: req.datasetId,
      itemId: req.itemId,
      payload: req.payload,
      idempotencyKey: req.idempotencyKey,
      status: "pending",
      requiresHarness: true,
      createdAt: now,
      attempts: 0,
    };
    db.prepare(
      "INSERT INTO events (id, type, datasetId, itemId, payload, status, requiresHarness, createdAt, attempts, idempotencyKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      event.id,
      event.type,
      event.datasetId ?? null,
      event.itemId ?? null,
      JSON.stringify(event.payload ?? null),
      event.status,
      event.requiresHarness ? 1 : 0,
      now,
      0,
      event.idempotencyKey ?? null
    );
    sseManager.broadcast("action", { id: event.id, status: event.status });
    return { event };
  }

  getPublicState(): DashboardState {
    return {
      publication: this.getCurrentPublication(),
      datasets: this.getAllDatasets(),
      serverTime: Date.now(),
      rendererVersion: RENDERER_VERSION,
      catalogueVersion: CATALOGUE_VERSION,
    };
  }

  getPublication(): Publication | null {
    return this.getCurrentPublication();
  }

  getDataset(id: string): Dataset | null {
    const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as Parameters<typeof parseDataset>[0] | undefined;
    return row ? parseDataset(row) : null;
  }

  listRevisions(): { revision: number; draftId: string; publishedAt: number; reviewId: string }[] {
    const rows = db.prepare("SELECT revision, draftId, publishedAt, reviewId FROM revisions ORDER BY revision DESC").all() as {
      revision: number;
      draftId: string;
      publishedAt: number;
      reviewId: string | null;
    }[];
    return rows.map((r) => ({ revision: r.revision, draftId: r.draftId, publishedAt: r.publishedAt, reviewId: r.reviewId ?? "" }));
  }

  getRevision(n: number): Publication | null {
    const row = db.prepare("SELECT * FROM revisions WHERE revision = ?").get(n) as Parameters<typeof parsePublication>[0] | undefined;
    return row ? parsePublication(row) : null;
  }

  rollback(args: { revision: number; idempotencyKey?: string }): PublishResult {
    const now = Date.now();
    const row = db.prepare("SELECT * FROM revisions WHERE revision = ?").get(args.revision) as Parameters<typeof parsePublication>[0] | undefined;
    if (!row) throw new AppError("not_found", `Revision ${args.revision} not found`);

    const pub = parsePublication(row);
    const validation = validateDesign(pub.content, { knownDatasets: this.knownDatasets(), datasetSchemas: this.datasetSchemas(), knownAssets: this.knownAssets() });
    if (validation.content === null) {
      throw new AppError("validation_failed", "Historic design no longer validates against current datasets: " + validation.diagnostics.map((d) => d.message).join("; "));
    }

    const currentRev = Number(getMeta("current_revision") ?? "0");
    const nextRev = currentRev + 1;

    const hash = contentHash(pub.content);

    // Idempotency for rollback if key provided
    if (args.idempotencyKey) {
      const idemRow = db.prepare("SELECT * FROM idempotency WHERE key = ? AND scope = 'rollback'").get(args.idempotencyKey) as
        | { result: string; createdAt: number }
        | undefined;
      if (idemRow && idemRow.createdAt > now - 24 * 60 * 60 * 1000) {
        return JSON.parse(idemRow.result) as PublishResult;
      }
    }

    const rollbackTx = db.transaction(() => {
      db.prepare(
        "INSERT INTO revisions (revision, draftId, draftVersion, contentHash, content, reviewId, publishedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(nextRev, pub.draftId, pub.draftVersion, hash, JSON.stringify(pub.content), pub.reviewId, now);
      setMeta("current_revision", String(nextRev));
      if (args.idempotencyKey) {
        db.prepare("INSERT OR REPLACE INTO idempotency (key, scope, result, createdAt) VALUES (?, ?, ?, ?)").run(
          args.idempotencyKey,
          "rollback",
          JSON.stringify({ publication: { revision: nextRev, draftId: pub.draftId, draftVersion: pub.draftVersion, contentHash: hash, content: pub.content, reviewId: pub.reviewId, publishedAt: now }, datasetChecks: [] }),
          now
        );
      }
    });
    rollbackTx();

    const publication: Publication = {
      revision: nextRev,
      draftId: pub.draftId,
      draftVersion: pub.draftVersion,
      contentHash: hash,
      content: pub.content,
      reviewId: pub.reviewId,
      publishedAt: now,
    };

    sseManager.broadcast("publication", { revision: nextRev, publishedAt: now });

    return {
      publication,
      datasetChecks: pub.content.datasets.map((id) => ({ datasetId: id, compatible: true })),
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function appErrorToHttpStatus(code: ErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "validation_failed":
      return 400;
    case "conflict":
      return 409;
    case "stale_review":
      return 409;
    case "precondition_failed":
      return 412;
    case "unauthorized":
      return 401;
    case "budget_exceeded":
      return 429;
    case "internal":
      return 500;
    default:
      return 500;
  }
}

function parseEventRow(row: {
  id: string;
  type: string;
  datasetId: string | null;
  itemId: string | null;
  payload: string | null;
  idempotencyKey: string | null;
  status: string;
  requiresHarness: number;
  createdAt: number;
  claimedAt: number | null;
  resolvedAt: number | null;
  attempts: number;
  lastError: string | null;
}): ActionEvent {
  return {
    id: row.id,
    type: row.type,
    datasetId: row.datasetId ?? undefined,
    itemId: row.itemId ?? undefined,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    status: row.status as ActionStatus,
    requiresHarness: Boolean(row.requiresHarness),
    createdAt: row.createdAt,
    claimedAt: row.claimedAt ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    attempts: row.attempts,
    lastError: row.lastError ?? undefined,
  };
}
