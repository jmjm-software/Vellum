/**
 * Vellum MCP stdio server.
 *
 * Exposes EXACTLY the six MCP_TOOL_NAMES from @vellum/core/protocol over the
 * Model Context Protocol (stdio transport). Handlers call the same AppService
 * as the HTTP routes — no internal HTTP hop (CONTRACTS.md §5).
 *
 * Server `instructions` = AUTHORING_GUIDANCE from core. Tool descriptions
 * state the next required step in the guarded loop (edit -> preview -> review
 * -> publish). dashboard_preview returns png image content blocks (base64
 * from the review's artifact files) alongside structured JSON.
 *
 * Auth: stdio MCP is spawned locally by the agent harness and inherits its
 * environment; VELLUM_AGENT_TOKEN is the logical credential for these tools
 * (auth.js warns when default dev tokens are in use).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { AUTHORING_GUIDANCE } from "@vellum/core";
import { MCP_TOOL_NAMES } from "@vellum/core/protocol.js";
import { zDatasetSchema, zDesignPatch } from "@vellum/core/validate.js";
import type {
  AssetArgs,
  ContextArgs,
  DataArgs,
  EditArgs,
  EventsArgs,
  PreviewArgs,
  PreviewResult,
  PublishArgs,
} from "@vellum/core/protocol.js";
import { AppService, isAppError } from "./app.js";
import { artifactDir } from "./db.js";
import "./auth.js"; // logs a warning when default dev tokens are in use

const service = new AppService();

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = isAppError(err) ? err.code : "internal";
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }],
    isError: true,
  };
}

/** Resolve a review screenshot path safely inside artifactDir (path-traversal protection). */
function safeScreenshotPath(relative: string): string | null {
  const resolved = resolve(artifactDir, relative);
  if (resolved !== artifactDir && !resolved.startsWith(artifactDir + sep)) return null;
  if (!existsSync(resolved)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Zod input schemas (mirror @vellum/core/protocol arg types)
// ---------------------------------------------------------------------------

const contextSchema = {
  includeDesign: z.boolean().optional().describe("Include full design content (default true)."),
  includeData: z.boolean().optional().describe("Include dataset values (default: summaries only).")
};

const editSchema = {
  draftId: z.string().optional().describe("Existing draft to patch. Omit to create a new draft."),
  expectedVersion: z.number().int().optional().describe("Required with draftId: optimistic concurrency on the draft version."),
  patches: z.array(zDesignPatch as unknown as z.ZodTypeAny).optional().describe("DesignPatch operations (replaceRoot, insert, remove, updateProps, move, setOverride, setDatasets, setIntent, setWidget)."),
  content: z.record(z.any()).optional().describe("Full replacement DesignContent (alternative to patches)."),
  base: z.enum(["current", "blank"]).optional().describe("Base for a new draft: current publication or blank.")
};

const previewSchema = {
  jobId: z.string().optional().describe("Retrieve the result of a previously enqueued preview job."),
  draftId: z.string().optional().describe("Draft to preview (required when jobId is not given)."),
  draftVersion: z.number().int().optional().describe("Exact draft version to preview; defaults to the draft's current version."),
  profiles: z.array(z.string()).optional().describe("Target profiles to render (default: all PREVIEW_PROFILES).")
};

const publishSchema = {
  draftId: z.string(),
  reviewId: z.string().describe("Review from a completed dashboard_preview of this exact draft version."),
  expectedPublishedRevision: z.number().int().nullable().describe("Optimistic concurrency: revision observed in dashboard_context (null if nothing published yet)."),
  idempotencyKey: z.string().describe("Dedupe key; replaying with the same key returns the same result.")
};

const dataSchema = {
  op: z.enum(["list", "get", "create", "update", "patchItem"]),
  datasetId: z.string().optional().describe("For get/update/patchItem."),
  definition: z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      title: z.string().min(1).max(200),
      ownership: z.enum(["dashboard", "mirrored"]),
      schema: zDatasetSchema,
      source: z.string().max(500).optional()
    })
    .optional()
    .describe("For create: DatasetDefinition { id, title, ownership, schema, source? }."),
  value: z.record(z.any()).optional().describe("For create/update: DatasetValue matching the schema."),
  itemId: z.string().optional().describe("For patchItem."),
  patch: z.object({ label: z.string().optional(), done: z.boolean().optional() }).optional().describe("For patchItem."),
  expectedVersion: z.number().int().optional().describe("Optimistic concurrency on the dataset version."),
  source: z.string().optional().describe("For update: provenance note.")
};

const assetSchema = {
  op: z.enum(["list", "upload", "get", "delete"]),
  assetId: z.string().optional().describe("For get/delete."),
  filename: z.string().max(200).optional().describe("For upload: original filename (metadata only)."),
  mimeType: z
    .enum(["image/png", "image/jpeg", "image/webp", "image/gif"])
    .optional()
    .describe("For upload: raster image type. SVG and remote URLs are not accepted."),
  dataBase64: z
    .string()
    .optional()
    .describe("For upload: raw base64 image bytes (no data: prefix). Max 5 MB, magic-byte checked against mimeType.")
};

const eventsSchema = {
  op: z.enum(["list", "claim", "ack", "submit"]),
  status: z.enum(["pending", "claimed", "completed", "failed"]).optional().describe("For list: filter by status."),
  limit: z.number().int().optional().describe("For list."),
  max: z.number().int().optional().describe("For claim: max events to claim."),
  claimant: z.string().optional().describe("For claim: who is claiming."),
  eventId: z.string().optional().describe("For ack."),
  outcome: z.enum(["success", "failed"]).optional().describe("For ack."),
  error: z.string().optional().describe("For ack with outcome=failed."),
  patch: z.object({ itemId: z.string().optional(), done: z.boolean().optional(), label: z.string().optional() }).optional().describe("For ack: reconcile the displayed state."),
  type: z.string().optional().describe("For submit: event type."),
  datasetId: z.string().optional().describe("For submit."),
  itemId: z.string().optional().describe("For submit."),
  payload: z.record(z.any()).optional().describe("For submit."),
  idempotencyKey: z.string().optional().describe("For submit: dedupe key.")
};

// ---------------------------------------------------------------------------
// dashboard_preview: image content blocks + structured JSON when a review exists
// ---------------------------------------------------------------------------

function previewNextStep(result: PreviewResult): string {
  if (result.status === "queued" || result.status === "running") {
    return `Preview is ${result.status}. Call dashboard_preview again with { "jobId": "${result.jobId}" } to retrieve the result.`;
  }
  if (result.status === "failed") {
    return `Preview failed (${result.error ?? "unknown error"}). Fix the problem with dashboard_edit and preview the new draft version.`;
  }
  const review = result.review;
  if (!review) return "Preview done but no review is attached; re-request the preview.";
  if (review.status === "failed") {
    return "Review FAILED (error diagnostics). Inspect the screenshots and diagnostics, repair with dashboard_edit, then preview the new draft version. Do NOT publish.";
  }
  return `Review ${review.id} ${review.status}. Inspect the screenshots yourself for overflow/clipping/empty states. If acceptable, publish with dashboard_publish { draftId: "${review.draftId}", reviewId: "${review.id}", expectedPublishedRevision: <revision from dashboard_context>, idempotencyKey: <unique key> }.`;
}

function buildPreviewResult(result: PreviewResult): CallToolResult {
  const review = result.review;
  const structured = {
    jobId: result.jobId,
    status: result.status,
    error: result.error,
    reviewId: review?.id ?? null,
    reviewStatus: review?.status ?? null,
    draftId: review?.draftId ?? null,
    draftVersion: review?.draftVersion ?? null,
    contentHash: review?.contentHash ?? null,
    profiles: review?.profiles ?? null,
    diagnostics: review?.diagnostics ?? null,
    datasetSnapshots: review?.datasetSnapshots ?? null,
    screenshots: review?.screenshots.map((s) => ({ profile: s.profile, target: s.target, width: s.width, height: s.height })) ?? [],
    nextStep: previewNextStep(result)
  };

  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(structured, null, 2) }
  ];

  if (review) {
    for (const shot of review.screenshots) {
      const file = safeScreenshotPath(shot.path);
      if (!file) continue;
      try {
        const dataBase64 = readFileSync(file).toString("base64");
        content.push({
          type: "image",
          data: dataBase64,
          mimeType: "image/png"
        });
      } catch {
        // artifact unreadable — structured JSON above still reports the review
      }
    }
  }

  return { content };
}

// ---------------------------------------------------------------------------
// Server & tool registration (exactly the six MCP_TOOL_NAMES)
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "vellum", version: "0.1.0" },
  { instructions: AUTHORING_GUIDANCE }
);

const registered = new Set<string>();

function register<T extends string>(name: T, description: string, inputSchema: Record<string, z.ZodTypeAny>, cb: (args: Record<string, unknown>) => CallToolResult): void {
  registered.add(name);
  server.registerTool(name, { description, inputSchema }, (args) => {
    try {
      return cb(args);
    } catch (err) {
      return errorResult(err);
    }
  });
}

register(
  "dashboard_context",
  "STEP 1 — Inspect the dashboard before any change. Returns the published design + revision, current draft, dataset summaries, component catalogue, and authoring guidance. Always call this first: you need published.revision as expectedPublishedRevision for dashboard_publish.",
  contextSchema,
  (args) => jsonResult(service.getContext(args as unknown as ContextArgs))
);

register(
  "dashboard_edit",
  "STEP 2 — Create or patch a draft design (component layout, bindings, overrides, intent). Returns validation diagnostics and the draft version. NEXT REQUIRED STEP: preview this exact draft version with dashboard_preview — a design cannot be published without a passing review of that exact version.",
  editSchema,
  (args) => jsonResult(service.edit(args as unknown as EditArgs))
);

register(
  "dashboard_preview",
  "STEP 3 — Render the exact draft version and produce a review with screenshots + diagnostics. Without jobId: enqueues a preview job and returns a job handle { jobId, status }. With { jobId }: returns that job's result; when done, includes png screenshots (image blocks) and the review. NEXT REQUIRED STEP: inspect the screenshots yourself; if the review passed, publish with dashboard_publish using its reviewId; if failed, repair with dashboard_edit and preview the new version.",
  previewSchema,
  (args) => {
    const jobId = args.jobId as string | undefined;
    const result = jobId
      ? service.getPreviewJob(jobId)
      : service.requestPreview(args as unknown as PreviewArgs);
    return buildPreviewResult(result);
  }
);

register(
  "dashboard_publish",
  "STEP 4 (final) — Publish a reviewed draft as the new live revision. Requires reviewId from a completed dashboard_preview bound to the CURRENT draft version (no edits since), expectedPublishedRevision observed in dashboard_context, and a unique idempotencyKey. Rejected if the review is missing, stale, failed, or contains error diagnostics.",
  publishSchema,
  (args) => jsonResult(service.publish(args as unknown as PublishArgs))
);

register(
  "dashboard_data",
  "Dataset CRUD: list / get / create / update (full value) / patchItem (single list item). Data changes NEVER require a redesign, preview, or publish — they go live immediately (dashboard-owned) or become pending harness events (mirrored). Validated against the dataset schema with optimistic version concurrency.",
  dataSchema,
  (args) => jsonResult(service.data(args as unknown as DataArgs))
);

register(
  "dashboard_asset",
  "Uploaded, access-controlled images for image components. Upload raster bytes (png/jpeg/webp/gif, ≤5 MB, base64) and reference the returned asset id from an image component's assetId. list/get/delete manage existing assets. Always preview the draft afterwards so the screenshot (which contains the real image) is inspected before publishing.",
  assetSchema,
  (args) => jsonResult(service.assets(args as unknown as AssetArgs))
);

register(
  "dashboard_events",
  "Action-event bridge for mirrored datasets: list / claim / ack / submit. The harness claims pending events, performs the real external action, then acks with outcome success|failed (optionally a patch to reconcile displayed state). Submitting the same idempotencyKey or the same pending (datasetId, itemId, type) dedupes.",
  eventsSchema,
  (args) => jsonResult(service.events(args as unknown as EventsArgs))
);

// Guard: exactly the six contract tools, no more, no less.
for (const name of MCP_TOOL_NAMES) {
  if (!registered.has(name)) throw new Error(`MCP tool "${name}" is not registered`);
}
if (registered.size !== MCP_TOOL_NAMES.length) {
  throw new Error(`Registered ${registered.size} tools but contract requires exactly ${MCP_TOOL_NAMES.length}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[vellum-mcp] stdio server ready (tools: %s)", MCP_TOOL_NAMES.join(", "));
