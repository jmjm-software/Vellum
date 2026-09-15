/**
 * Wire protocol shared by the MCP server, HTTP API, and clients.
 * MCP handlers and HTTP handlers call the same application functions (§10);
 * these types define the request/response shapes for both.
 */
import type {
  ActionEvent,
  ActionStatus,
  AssetInfo,
  DashboardState,
  Dataset,
  DatasetDefinition,
  DatasetSchema,
  DatasetValue,
  DesignContent,
  Diagnostic,
  Draft,
  Publication,
  ReviewRecord,
  TargetKind
} from "./types.js";
import type { DesignPatch } from "./validate.js";

// ---------------------------------------------------------------------------
// MCP tool names (architecture §5) — exactly six, one MCP connection
// ---------------------------------------------------------------------------

export const MCP_TOOL_NAMES = [
  "dashboard_context",
  "dashboard_edit",
  "dashboard_preview",
  "dashboard_publish",
  "dashboard_data",
  "dashboard_asset",
  "dashboard_events"
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Tool arguments & results
// ---------------------------------------------------------------------------

export interface ContextArgs {
  /** Include full design content (default true). */
  includeDesign?: boolean;
  /** Include dataset values (default: summaries only). */
  includeData?: boolean;
}

export interface ContextResult {
  published: {
    revision: number;
    contentHash: string;
    publishedAt: number;
    content?: DesignContent;
  } | null;
  draft: { id: string; version: number; updatedAt: number; content?: DesignContent } | null;
  datasets: DatasetSummary[];
  targets: { kind: TargetKind; supported: boolean; notes?: string }[];
  capabilities: {
    preview: boolean;
    /** Launcher-widget previews (drawn by the layout mirror). */
    widget: boolean;
    continuousMode: boolean;
  };
  /** Authoring guidance bundled with the response (§5: bundle the guidance). */
  guidance: string;
  catalogue: string;
  versions: { format: number; catalogue: string; renderer: string };
}

export interface DatasetSummary {
  id: string;
  title: string;
  ownership: DatasetDefinition["ownership"];
  schemaKind: DatasetSchema["kind"];
  version: number;
  updatedAt: number;
  /** Kind-specific quick facts, e.g. { itemCount: 12, unchecked: 5 }. */
  facts: Record<string, number | string>;
}

export interface EditArgs {
  /** Omit to create a new draft from the current publication (or blank). */
  draftId?: string;
  /** Required when draftId is given: optimistic concurrency on the draft. */
  expectedVersion?: number;
  patches?: DesignPatch[];
  /** Full replacement content (alternative to patches). */
  content?: DesignContent;
  base?: "current" | "blank";
}

export interface EditResult {
  draftId: string;
  version: number;
  diagnostics: Diagnostic[];
  valid: boolean;
  nextStep: string;
}

export interface PreviewArgs {
  draftId: string;
  /** Exactly bound to a draft version (§6). Defaults to the draft's current version. */
  draftVersion?: number;
  profiles?: string[];
}

export interface PreviewResult {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  review?: ReviewRecord;
  /** Inline images for MCP tool results (image content blocks). */
  screenshots?: { profile: string; target: TargetKind; mimeType: string; dataBase64: string }[];
  error?: string;
}

export interface PublishArgs {
  draftId: string;
  reviewId: string;
  expectedPublishedRevision: number | null;
  idempotencyKey: string;
}

export interface PublishResult {
  publication: Publication;
  /** Live datasets were verified compatible with review constraints (§6). */
  datasetChecks: { datasetId: string; compatible: boolean; note?: string }[];
}

export type DataArgs =
  | { op: "list" }
  | { op: "get"; datasetId: string }
  | { op: "create"; definition: DatasetDefinition; value?: DatasetValue }
  | { op: "update"; datasetId: string; expectedVersion?: number; value: DatasetValue; source?: string }
  | { op: "patchItem"; datasetId: string; itemId: string; expectedVersion?: number; patch: { label?: string; done?: boolean } };

export type DataResult =
  | { op: "list"; datasets: DatasetSummary[] }
  | { op: "get"; dataset: Dataset }
  | { op: "create"; dataset: Dataset }
  | { op: "update"; dataset: Dataset }
  | { op: "patchItem"; dataset: Dataset; action?: ActionEvent };

export type EventsArgs =
  | { op: "list"; status?: ActionStatus; limit?: number }
  | { op: "claim"; max?: number; claimant?: string }
  | { op: "ack"; eventId: string; outcome: "success" | "failed"; error?: string; patch?: { itemId?: string; done?: boolean; label?: string } }
  | { op: "submit"; type: string; datasetId?: string; itemId?: string; payload?: Record<string, unknown>; idempotencyKey?: string };

export type EventsResult =
  | { op: "list"; events: ActionEvent[] }
  | { op: "claim"; events: ActionEvent[] }
  | { op: "ack"; event: ActionEvent }
  | { op: "submit"; event: ActionEvent };

// ---------------------------------------------------------------------------
// Assets (uploaded, access-controlled images; §10)
// ---------------------------------------------------------------------------

export type AssetArgs =
  | { op: "list" }
  /** Upload a raster image. `dataBase64` is raw base64 (no data: prefix). */
  | { op: "upload"; filename?: string; mimeType: string; dataBase64: string }
  | { op: "get"; assetId: string }
  | { op: "delete"; assetId: string };

export type AssetResult =
  | { op: "list"; assets: AssetInfo[] }
  | { op: "upload"; asset: AssetInfo; nextStep: string }
  | { op: "get"; asset: AssetInfo }
  | { op: "delete"; assetId: string; deleted: boolean };

// ---------------------------------------------------------------------------
// HTTP client API (web / Android / CLI all use these)
// ---------------------------------------------------------------------------

export const HTTP_ROUTES = {
  state: "GET /api/state",
  publication: "GET /api/publication",
  dataset: "GET /api/datasets/:id",
  submitAction: "POST /api/actions",
  assets: "GET /api/assets/:id",
  screenshots: "GET /api/reviews/:reviewId/screenshots/:profile",
  stream: "GET /api/stream",
  health: "GET /api/health",
  // Agent routes (agent-token protected); same app functions as MCP:
  agentContext: "POST /api/agent/context",
  agentEdit: "POST /api/agent/edit",
  agentPreview: "POST /api/agent/preview",
  agentPublish: "POST /api/agent/publish",
  agentData: "POST /api/agent/data",
  agentAsset: "POST /api/agent/assets",
  agentEvents: "POST /api/agent/events"
} as const;

/** POST /api/actions body (dashboard-local action path, §9). */
export interface SubmitActionRequest {
  type: "toggleItem" | string;
  datasetId: string;
  itemId?: string;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface SubmitActionResult {
  event: ActionEvent;
  /** Present when the action was applied locally (dashboard-owned dataset). */
  dataset?: Dataset;
}

/** SSE event names emitted on /api/stream. */
export type StreamEventName = "publication" | "dataset" | "action";

export interface StreamMessage {
  event: StreamEventName;
  id: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Preview worker job queue (database-backed, §10)
// ---------------------------------------------------------------------------

export type PreviewJobStatus = "queued" | "running" | "done" | "failed";

export interface PreviewJob {
  id: string;
  draftId: string;
  draftVersion: number;
  contentHash: string;
  profiles: string[];
  status: PreviewJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  reviewId?: string;
  error?: string;
  attempts: number;
}

/** Server -> worker handoff payload. */
export interface PreviewJobPayload {
  job: PreviewJob;
  draft: Draft;
  datasets: Dataset[];
  rendererVersion: string;
  catalogueVersion: string;
  /** Base URL of the isolated preview renderer page (production renderer, §7). */
  rendererUrl: string;
  artifactDir: string;
}
