/**
 * @vellum/core — shared domain types and contracts.
 *
 * Central concepts (see architecture.md §3):
 *  - Dataset: values/records/list items/time-series samples (data, not design)
 *  - DesignRevision: components, bindings, layout, responsive behavior (design, not data)
 *  - Publication: the approved design revision clients display
 *  - ActionEvent: a user interaction and its processing state
 */

import WIDGET_LAYOUT_JSON from "./widget-layout.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Identifiers & versioning
// ---------------------------------------------------------------------------

export type ID = string;

export const FORMAT_VERSION = 1;
export const CATALOGUE_VERSION = "1.0.0";
export const RENDERER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Targets & preview profiles
// ---------------------------------------------------------------------------

/** Presentation targets. `widget` is the Android launcher surface (later milestone). */
export type TargetKind = "phone" | "desktop" | "widget";

export interface TargetProfile {
  target: TargetKind;
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/** Modest starting test matrix (architecture §7). */
export const PREVIEW_PROFILES: TargetProfile[] = [
  { target: "phone", name: "phone-small", width: 360, height: 640, deviceScaleFactor: 2 },
  { target: "phone", name: "phone-large", width: 412, height: 915, deviceScaleFactor: 2 },
  { target: "desktop", name: "desktop", width: 1280, height: 800, deviceScaleFactor: 1 }
];

// ---------------------------------------------------------------------------
// Component document (agent-authored composition)
// ---------------------------------------------------------------------------

export interface ComponentNode {
  /** Stable component ID — used for patch-based editing (`dashboard_edit`). */
  id: string;
  /** Catalogue component type, e.g. "grid", "checklist", "metric". */
  type: string;
  props?: Record<string, unknown>;
  children?: ComponentNode[];
}

/** Per-target presentation overrides, keyed by component id. */
export interface TargetOverride {
  /** Grid span override (grid columns, default 12). */
  span?: number;
  /** Ordering override within the parent container. */
  order?: number;
  /** Hide the component on this target. */
  hidden?: boolean;
  /** Compact presentation hint (renderer decides concrete density). */
  compact?: boolean;
}

/** Durable design intent stored alongside the layout (architecture §8). */
export interface DesignIntent {
  purpose?: string;
  /** User-requested priorities, most important first. */
  priorities?: string[];
  /** Why something was moved to a secondary view, etc. */
  notes?: string;
}

/**
 * The versioned dashboard envelope: layout specification, dataset references,
 * target-specific presentations, compatibility metadata (architecture §2).
 */
export interface DesignContent {
  formatVersion: number;
  catalogueVersion: string;
  root: ComponentNode;
  /** Per-target overrides: target -> componentId -> override. */
  overrides?: Partial<Record<TargetKind, Record<string, TargetOverride>>>;
  /** Dataset ids this design binds to. Must exist (or be created) at publish time. */
  datasets: ID[];
  intent?: DesignIntent;
  /** Optional compact launcher-widget presentation of the same datasets (§4). */
  widget?: WidgetSpec | null;
}

/** Agent-designed compact widget presentation (small trusted native catalogue). */
export interface WidgetSpec {
  /** Ordered widget components from the widget catalogue. */
  components: WidgetComponent[];
  /** Dataset ids the widget binds to. */
  datasets: ID[];
}

/**
 * How much room a widget image takes. Semantic (not pixel values) so the native
 * renderer stays in control of the actual layout; the agent tunes prominence.
 */
export type WidgetImageSize = "small" | "medium" | "large";

/**
 * The widget's visual layout, kept in one place (widget-layout.json) so the
 * TypeScript mirror used for previews and the Kotlin Glance renderer that draws
 * the real launcher widget cannot drift apart. A Kotlin unit test asserts the
 * Kotlin constants against this file.
 */
export interface WidgetLayout {
  padding: number;
  compactPadding: number;
  compactHeightBelow: number;
  gap: number;
  radius: number;
  actionRadius: number;
  colors: Record<string, string>;
  type: Record<string, number>;
  imageHeights: Record<WidgetImageSize, number>;
  imageRadius: number;
  listRowPaddingY: number;
  dividerHeight: number;
  maxListItems: number;
  budget: { under130: number; under200: number; under300: number; else: number };
  profiles: Record<string, { width: number; height: number }>;
}

export const WIDGET_LAYOUT: WidgetLayout = WIDGET_LAYOUT_JSON as WidgetLayout;

export const WIDGET_IMAGE_HEIGHTS: Record<WidgetImageSize, number> = WIDGET_LAYOUT.imageHeights;

/**
 * Launcher-widget preview profiles, rendered by the built-in layout mirror in
 * the regular Playwright preview worker (works on any architecture). Names are
 * distinct from native-renderer output, so a review shows which source produced
 * a screenshot: `widget-mirror-*` = approximate mirror, `widget-*` = native.
 */
export const WIDGET_PREVIEW_PROFILES: TargetProfile[] = Object.entries(WIDGET_LAYOUT.profiles).map(
  ([name, size]) => ({
    target: "widget" as const,
    name: name.replace(/^widget-/, "widget-mirror-"),
    width: size.width,
    height: size.height
  })
);

export type WidgetComponent =
  | { kind: "text"; text: string; emphasis?: "title" | "normal" | "caption" }
  | { kind: "metric"; dataset: ID; field: string; label?: string; unit?: string }
  | { kind: "list"; dataset: ID; maxItems: number; filter?: "unchecked" | "all"; showRemainingCount?: boolean }
  | { kind: "progress"; dataset: ID; label?: string }
  | { kind: "image"; assetId: string; alt?: string; size?: WidgetImageSize }
  | { kind: "link"; label: string; href: string }
  | { kind: "action"; label: string; action: ActionSpec };

/** Action a component can trigger. No arbitrary URLs beyond http(s), no expressions (§10). */
export type ActionSpec =
  | { kind: "toggleItem"; dataset: ID; itemId: string }
  | { kind: "event"; type: string; payload?: Record<string, unknown> }
  | { kind: "openDashboard" }
  /** Opens an external http(s) page in the platform browser (validated). */
  | { kind: "openUrl"; href: string };

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export type DatasetOwnership = "dashboard" | "mirrored";

export type DatasetSchema =
  | { kind: "list"; maxItems?: number }
  | { kind: "metric"; fields: MetricField[] }
  | { kind: "timeseries"; series: MetricField[]; maxSamples?: number }
  | { kind: "records"; columns: RecordColumn[]; maxRows?: number };

export interface MetricField {
  name: string;
  unit?: string;
}

export interface RecordColumn {
  name: string;
  type: "string" | "number" | "boolean";
}

export type DatasetValue =
  | { kind: "list"; items: ListItem[] }
  | { kind: "metric"; values: Record<string, number> }
  | { kind: "timeseries"; samples: TimeseriesSample[] }
  | { kind: "records"; rows: Record<string, string | number | boolean | null>[] };

export interface ListItem {
  id: string;
  label: string;
  done?: boolean;
  meta?: Record<string, string>;
}

export interface TimeseriesSample {
  /** Epoch milliseconds. */
  t: number;
  values: Record<string, number>;
}

export interface DatasetDefinition {
  id: ID;
  title: string;
  ownership: DatasetOwnership;
  schema: DatasetSchema;
  /** Opaque source reference for mirrored data. Never credentials (§3). */
  source?: string;
}

export interface Dataset extends DatasetDefinition {
  value: DatasetValue;
  /** Epoch ms of last data change. */
  updatedAt: number;
  /** Optimistic-concurrency version for data changes (independent of design, §6). */
  version: number;
}

/** Hard bounds for data updates (§3: data updates pass schema and size constraints). */
export const DATA_LIMITS = {
  maxListItems: 2000,
  maxTimeseriesSamples: 5000,
  maxRecordRows: 2000,
  maxLabelLength: 500,
  maxPayloadBytes: 1_000_000
} as const;

/**
 * Uploaded asset bounds (§10: prefer uploaded, access-controlled assets over
 * arbitrary remote URLs). Raster formats only — SVG can carry script and is not
 * rendered from untrusted uploads.
 */
export const ASSET_LIMITS = {
  maxBytes: 5_000_000,
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
} as const;

export type AssetMimeType = (typeof ASSET_LIMITS.mimeTypes)[number];

export interface AssetInfo {
  id: string;
  mimeType: string;
  bytes: number;
  filename?: string;
  createdAt: number;
  /** Client-facing URL (access-controlled). */
  url: string;
}

// ---------------------------------------------------------------------------
// Drafts, reviews, publications
// ---------------------------------------------------------------------------

export interface Draft {
  id: ID;
  /** Incremented on every edit; a review binds to an exact version (§6). */
  version: number;
  content: DesignContent;
  updatedAt: number;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  componentId?: string;
  target?: string;
}

export interface ScreenshotArtifact {
  profile: string;
  target: TargetKind;
  /** Relative path under the artifact directory; access-controlled (§10). */
  path: string;
  width: number;
  height: number;
}

export type ReviewStatus = "passed" | "passed_with_warnings" | "failed";

/** Preview evidence bound to the exact draft version (§6). */
export interface ReviewRecord {
  id: ID;
  draftId: ID;
  draftVersion: number;
  contentHash: string;
  rendererVersion: string;
  catalogueVersion: string;
  profiles: string[];
  diagnostics: Diagnostic[];
  screenshots: ScreenshotArtifact[];
  /** Dataset snapshots used during preview (id -> version). */
  datasetSnapshots: Record<ID, number>;
  status: ReviewStatus;
  createdAt: number;
}

export interface Publication {
  revision: number;
  draftId: ID;
  draftVersion: number;
  contentHash: string;
  content: DesignContent;
  reviewId: ID;
  publishedAt: number;
}

// ---------------------------------------------------------------------------
// Actions & events (§9)
// ---------------------------------------------------------------------------

export type ActionStatus = "pending" | "claimed" | "completed" | "failed";

/**
 * A user interaction. Dashboard-owned datasets are applied locally (no model
 * call). Mirrored datasets produce an event the harness must claim/ack.
 */
export interface ActionEvent {
  id: ID;
  type: string;
  datasetId?: ID;
  itemId?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  /** dashboard-owned actions are applied immediately -> completed. */
  status: ActionStatus;
  requiresHarness: boolean;
  createdAt: number;
  claimedAt?: number;
  resolvedAt?: number;
  attempts: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Client-facing state
// ---------------------------------------------------------------------------

export interface DashboardState {
  publication: Publication | null;
  datasets: Dataset[];
  serverTime: number;
  rendererVersion: string;
  catalogueVersion: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "stale_review"
  | "precondition_failed"
  | "unauthorized"
  | "budget_exceeded"
  | "internal";

export interface VellumError {
  error: ErrorCode;
  message: string;
  details?: unknown;
}
