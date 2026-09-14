/**
 * Vellum HTTP server (express).
 *
 * - Client API per HTTP_ROUTES (client-token protected)
 * - Agent API: POST /api/agent/* (agent-token protected) — same AppService as MCP, no HTTP hop
 * - SSE stream at GET /api/stream
 * - Serves packages/web/dist statically at / when present
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AppService, appErrorToHttpStatus, isAppError } from "./app.js";
import { artifactDir, db } from "./db.js";
import { requireAgentToken, requireClientOrAgentToken, requireClientToken } from "./auth.js";
import { sseManager } from "./sse.js";
import { CATALOGUE_VERSION, RENDERER_VERSION } from "@vellum/core/types.js";
import type {
  ContextArgs,
  DataArgs,
  EditArgs,
  EventsArgs,
  PreviewArgs,
  PublishArgs,
  SubmitActionRequest,
} from "@vellum/core/protocol.js";
import type { ErrorCode, ReviewRecord } from "@vellum/core/types.js";

const ERROR_CODES = new Set<ErrorCode>([
  "not_found",
  "validation_failed",
  "conflict",
  "stale_review",
  "precondition_failed",
  "unauthorized",
  "budget_exceeded",
  "internal",
]);

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const app = express();
const service = new AppService();

app.use(express.json({ limit: "4mb" }));
app.disable("x-powered-by");

function sendError(res: Response, err: unknown): void {
  if (isAppError(err)) {
    res.status(appErrorToHttpStatus(err.code)).json({ error: err.code, message: err.message });
    return;
  }
  const code = (err as { code?: string }).code as ErrorCode | undefined;
  if (code && ERROR_CODES.has(code)) {
    res.status(appErrorToHttpStatus(code)).json({ error: code, message: (err as Error).message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[vellum-server] internal error:", message);
  res.status(500).json({ error: "internal", message: "Internal server error" });
}

type Handler = (req: Request, res: Response) => unknown;

/** Wrap a synchronous handler: return values become JSON, thrown AppErrors map to HTTP status. */
function wrap(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void next;
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
    }
  };
}

/** Resolve a relative artifact path safely inside artifactDir (path-traversal protection). */
function safeArtifactPath(relative: string): string | null {
  const resolved = resolve(artifactDir, relative);
  if (resolved !== artifactDir && !resolved.startsWith(artifactDir + sep)) return null;
  if (!existsSync(resolved)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Health (public)
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    serverTime: Date.now(),
    rendererVersion: RENDERER_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
  });
});

// ---------------------------------------------------------------------------
// Client API (client token)
// ---------------------------------------------------------------------------

app.get("/api/state", requireClientToken, wrap(() => service.getPublicState()));

app.get("/api/publication", requireClientToken, wrap(() => ({ publication: service.getPublication() })));

app.get(
  "/api/datasets/:id",
  requireClientToken,
  wrap((req) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) throw Object.assign(new Error(`Bad dataset id "${id}"`), { code: "not_found" });
    const ds = service.getDataset(id);
    if (!ds) {
      // 404 via AppError-style shape
      const err = new Error(`Dataset "${id}" not found`) as Error & { code?: string };
      err.code = "not_found";
      throw err;
    }
    return ds;
  })
);

app.get("/api/history", requireClientToken, wrap(() => ({ revisions: service.listRevisions() })));

app.get(
  "/api/history/:revision",
  requireClientToken,
  wrap((req) => {
    const n = Number(req.params.revision);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("Bad revision"), { code: "not_found" });
    const revision = service.getRevision(n);
    if (!revision) throw Object.assign(new Error(`Revision ${n} not found`), { code: "not_found" });
    return revision;
  })
);

app.post(
  "/api/actions",
  requireClientToken,
  wrap((req) => {
    const body = req.body as Partial<SubmitActionRequest>;
    if (typeof body?.type !== "string" || body.type.length === 0 || body.type.length > 100) {
      throw Object.assign(new Error("body.type must be a non-empty string"), { code: "validation_failed" });
    }
    if (typeof body.datasetId !== "string" || !ID_RE.test(body.datasetId)) {
      throw Object.assign(new Error("body.datasetId is required"), { code: "validation_failed" });
    }
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0 || body.idempotencyKey.length > 200) {
      throw Object.assign(new Error("body.idempotencyKey is required"), { code: "validation_failed" });
    }
    return service.clientAction(body as SubmitActionRequest);
  })
);

// Assets and screenshots: client-or-agent token, path-traversal protected.

app.get(
  "/api/assets/:id",
  requireClientOrAgentToken,
  (req, res) => {
    try {
      const id = req.params.id;
      if (!ID_RE.test(id)) {
        res.status(404).json({ error: "not_found", message: "Asset not found" });
        return;
      }
      const row = db.prepare("SELECT data, mimeType FROM assets WHERE id = ?").get(id) as
        | { data: Buffer; mimeType: string }
        | undefined;
      if (!row) {
        res.status(404).json({ error: "not_found", message: `Asset "${id}" not found` });
        return;
      }
      res.setHeader("Content-Type", row.mimeType);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(row.data);
    } catch (err) {
      sendError(res, err);
    }
  }
);

app.get(
  "/api/reviews/:reviewId/screenshots/:profile",
  requireClientOrAgentToken,
  (req, res) => {
    try {
      const { reviewId, profile } = req.params;
      if (!ID_RE.test(reviewId) || !ID_RE.test(profile)) {
        res.status(404).json({ error: "not_found", message: "Review screenshot not found" });
        return;
      }
      const row = db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId) as
        | { screenshots: string }
        | undefined;
      if (!row) {
        res.status(404).json({ error: "not_found", message: `Review "${reviewId}" not found` });
        return;
      }
      const screenshots = JSON.parse(row.screenshots) as ReviewRecord["screenshots"];
      const shot = screenshots.find((s) => s.profile === profile);
      if (!shot) {
        res.status(404).json({ error: "not_found", message: `No screenshot for profile "${profile}"` });
        return;
      }
      const file = safeArtifactPath(shot.path);
      if (!file) {
        res.status(404).json({ error: "not_found", message: "Screenshot artifact missing" });
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(readFileSync(file));
    } catch (err) {
      sendError(res, err);
    }
  }
);

// SSE stream (client token).

app.get("/api/stream", requireClientToken, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
  sseManager.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* closed */
    }
  }, 25_000);
  req.on("close", () => clearInterval(ping));
});

// ---------------------------------------------------------------------------
// Agent API (agent token) — same AppService functions as MCP
// ---------------------------------------------------------------------------

app.post("/api/agent/context", requireAgentToken, wrap((req) => service.getContext((req.body ?? {}) as ContextArgs)));
app.post("/api/agent/edit", requireAgentToken, wrap((req) => service.edit((req.body ?? {}) as EditArgs)));

app.post(
  "/api/agent/preview",
  requireAgentToken,
  wrap((req) => {
    const body = (req.body ?? {}) as PreviewArgs & { jobId?: string };
    // Job-handle retrieval: { jobId } polls an existing job (same semantics as MCP dashboard_preview).
    if (body.jobId && !body.draftId) return service.getPreviewJob(body.jobId);
    if (typeof body.draftId !== "string" || body.draftId.length === 0) {
      throw Object.assign(new Error("draftId (or jobId) is required"), { code: "validation_failed" });
    }
    return service.requestPreview(body);
  })
);

app.post("/api/agent/publish", requireAgentToken, wrap((req) => {
  const body = (req.body ?? {}) as Partial<PublishArgs>;
  if (typeof body.draftId !== "string" || typeof body.reviewId !== "string" || typeof body.idempotencyKey !== "string") {
    throw Object.assign(new Error("draftId, reviewId and idempotencyKey are required"), { code: "validation_failed" });
  }
  return service.publish(body as PublishArgs);
}));
app.post("/api/agent/data", requireAgentToken, wrap((req) => service.data((req.body ?? {}) as DataArgs)));
app.post("/api/agent/events", requireAgentToken, wrap((req) => service.events((req.body ?? {}) as EventsArgs)));

app.post(
  "/api/agent/rollback",
  requireAgentToken,
  wrap((req) => {
    const body = (req.body ?? {}) as { revision?: unknown; idempotencyKey?: unknown };
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision <= 0) {
      throw Object.assign(new Error("body.revision (positive integer) is required"), { code: "validation_failed" });
    }
    return service.rollback({
      revision,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    });
  })
);

// ---------------------------------------------------------------------------
// Static web client (packages/web/dist) when present
// ---------------------------------------------------------------------------

const webDist = resolve(here, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback for non-API GETs (e.g. /preview.html deep links).
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    const indexFile = join(webDist, "index.html");
    if (existsSync(indexFile)) res.sendFile(indexFile);
    else next();
  });
} else {
  app.get("/", (_req, res) => {
    res.json({ service: "vellum", note: "web client not built (packages/web/dist missing)", api: "/api/health" });
  });
}

// 404 for unmatched API routes.
app.use((req, res) => {
  res.status(404).json({ error: "not_found", message: `No route ${req.method} ${req.path}` });
});

const server = app.listen(PORT, () => {
  console.log(`[vellum-server] listening on http://localhost:${PORT} (data: ${process.env.VELLUM_DATA_DIR ?? "./.vellum-data"})`);
});

function shutdown(): void {
  console.log("[vellum-server] shutting down");
  sseManager.closeAll();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* noop */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
