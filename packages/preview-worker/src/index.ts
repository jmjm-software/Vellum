/**
 * Vellum preview worker.
 *
 * Polls the shared SQLite job queue (preview_jobs) every 2s, claims a queued
 * job atomically, renders the bound draft version through the web app's
 * isolated /preview.html page (production renderer, sandboxed data), takes
 * per-profile screenshots, runs diagnostics + a checklist interaction test,
 * writes a ReviewRecord row and marks the job done (or failed).
 *
 * Env:
 *   VELLUM_DATA_DIR      data dir shared with the server (default ./.vellum-data)
 *   VELLUM_RENDERER_URL  base URL of the preview page (default http://localhost:8788)
 *   VELLUM_POLL_INTERVAL_MS  queue poll interval (default 2000)
 *   VELLUM_JOB_TIMEOUT_MS    per-job overall timeout (default 240000)
 */
import { randomBytes } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  CATALOGUE_VERSION,
  PREVIEW_PROFILES,
  RENDERER_VERSION,
  WIDGET_PREVIEW_PROFILES,
  contentHash
} from "@vellum/core";
import type {
  Dataset,
  DesignContent,
  Diagnostic,
  ReviewRecord,
  ReviewStatus,
  TargetProfile
} from "@vellum/core/types.js";
import {
  artifactDir,
  claimNextJob,
  db,
  getDraft,
  getDatasetsById,
  insertReview,
  markJobDone,
  markJobFailed,
  releaseJobToQueued,
  setMeta,
  type DatasetRow,
  type PreviewJobRow
} from "./db.js";
import { runAllProfiles, collectAssetIds, inlineAssets, renderWidgetPreviews } from "./render.js";

const rendererUrl = process.env.VELLUM_RENDERER_URL ?? "http://localhost:8788";
// Used only to read uploaded assets for inlining into preview specs.
const clientToken = process.env.VELLUM_CLIENT_TOKEN ?? "client-dev-token";
// Optional native widget renderer (see scripts/render-widget-previews.sh). When
// unset, widget designs are published without a visual review — and the review
// says so explicitly instead of pretending otherwise.
const widgetRendererCmd = process.env.VELLUM_WIDGET_RENDERER_CMD ?? "";
// Sidecar renderer (preferred in containers: no JDK/Android SDK needed here).
const widgetRendererUrl = process.env.VELLUM_WIDGET_RENDERER_URL ?? "";
// When a renderer is configured but fails, publication is blocked by default.
// Set VELLUM_REQUIRE_WIDGET_REVIEW=0 to downgrade widget failures to warnings
// (e.g. a flaky sidecar you do not want to gate on).
const requireWidgetReview = (process.env.VELLUM_REQUIRE_WIDGET_REVIEW ?? "1") !== "0";
const pollIntervalMs = Number(process.env.VELLUM_POLL_INTERVAL_MS ?? 2000);
const jobTimeoutMs = Number(process.env.VELLUM_JOB_TIMEOUT_MS ?? 240_000); // ~4 min

// ---------------------------------------------------------------------------
// Browser lifecycle (single reused browser)
// ---------------------------------------------------------------------------

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true });
  return browser;
}

async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b) await b.close().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

function rowToDataset(row: DatasetRow): Dataset {
  return {
    id: row.id,
    title: row.title,
    ownership: row.ownership as Dataset["ownership"],
    schema: JSON.parse(row.schema) as Dataset["schema"],
    value: JSON.parse(row.value) as Dataset["value"],
    source: row.source ?? undefined,
    updatedAt: row.updatedAt,
    version: row.version
  };
}

function resolveProfiles(names: string[]): { profiles: TargetProfile[]; diagnostics: Diagnostic[] } {
  const known = [...PREVIEW_PROFILES, ...WIDGET_PREVIEW_PROFILES];
  const diagnostics: Diagnostic[] = [];
  const wanted = names.length > 0 ? names : PREVIEW_PROFILES.map((p) => p.name);
  const profiles: TargetProfile[] = [];
  for (const name of wanted) {
    const profile = known.find((p) => p.name === name);
    if (profile) {
      profiles.push(profile);
    } else {
      diagnostics.push({
        severity: "warning",
        code: "unknown_profile",
        message: `Unknown preview profile "${name}" (known: ${known.map((p) => p.name).join(", ")})`
      });
    }
  }
  return { profiles, diagnostics };
}

function computeStatus(diagnostics: Diagnostic[]): ReviewStatus {
  if (diagnostics.some((d) => d.severity === "error")) return "failed";
  if (diagnostics.some((d) => d.severity === "warning")) return "passed_with_warnings";
  return "passed";
}

async function runJob(job: PreviewJobRow): Promise<void> {
  const draftRow = getDraft(job.draftId);
  if (!draftRow) throw new Error(`draft not found: ${job.draftId}`);
  const content = JSON.parse(draftRow.content) as DesignContent;
  const hash = contentHash(content);
  if (hash !== job.contentHash) {
    throw new Error(
      `content hash mismatch for draft ${job.draftId}: job=${job.contentHash} computed=${hash}`
    );
  }
  if (draftRow.version !== job.draftVersion) {
    throw new Error(
      `draft version moved on: job bound to v${job.draftVersion}, draft is v${draftRow.version}`
    );
  }

  const datasets = getDatasetsById(content.datasets ?? []).map(rowToDataset);
  const datasetSnapshots: Record<string, number> = {};
  for (const ds of datasets) datasetSnapshots[ds.id] = ds.version;

  const { profiles, diagnostics: profileDiagnostics } = resolveProfiles(
    safeParseProfiles(job.profiles)
  );
  // A widget design always gets mirror previews: they cost nothing extra (same
  // Playwright worker, same browser) and work on any architecture.
  const hasWidgetDesign = (content.widget?.components?.length ?? 0) > 0;
  if (hasWidgetDesign) {
    for (const profile of WIDGET_PREVIEW_PROFILES) {
      if (!profiles.some((p) => p.name === profile.name)) profiles.push(profile);
    }
  }
  if (profiles.length === 0) throw new Error("no runnable preview profiles");

  const reviewId = `review_${randomBytes(8).toString("hex")}`;
  const b = await getBrowser();
  // Inline uploaded images so the reviewed screenshots contain the real asset
  // bytes (previews render one self-contained spec; no network in the sandbox).
  const assetIds = collectAssetIds(content);
  const inlined =
    assetIds.length > 0
      ? await inlineAssets(rendererUrl, clientToken, assetIds)
      : { assets: {} as Record<string, string>, diagnostics: [] as Diagnostic[] };

  const results = await runAllProfiles(
    b,
    rendererUrl,
    reviewId,
    artifactDir,
    content,
    datasets,
    profiles,
    inlined.assets
  );

  const diagnostics: Diagnostic[] = [...profileDiagnostics, ...inlined.diagnostics];
  const screenshots: ReviewRecord["screenshots"] = [];
  for (const r of results) {
    diagnostics.push(...r.diagnostics);
    if (r.screenshot) screenshots.push(r.screenshot);
  }

  // Launcher widget: mirror previews are always produced (above). A native
  // renderer, when attached, replaces them with launcher-accurate screenshots.
  if (hasWidgetDesign) {
    if (widgetRendererCmd || widgetRendererUrl) {
      const widgetResult = await renderWidgetPreviews(
        widgetRendererCmd,
        widgetRendererUrl || undefined,
        rendererUrl,
        reviewId,
        artifactDir,
        content,
        datasets,
        inlined.assets
      );
      diagnostics.push(
        ...(requireWidgetReview
          ? widgetResult.diagnostics
          : widgetResult.diagnostics.map((d) => (d.severity === "error" ? { ...d, severity: "warning" as const } : d)))
      );
      if (widgetResult.screenshots.length > 0) {
        // Native supersedes the mirror: drop the approximate shots so the review
        // shows exactly one, authoritative widget preview.
        for (let i = screenshots.length - 1; i >= 0; i--) {
          if (screenshots[i].target === "widget") screenshots.splice(i, 1);
        }
        screenshots.push(...widgetResult.screenshots);
        diagnostics.push({
          severity: "info",
          code: "widget_preview_native",
          message: "widget previews were rendered by the native renderer (launcher-accurate)",
          target: "widget"
        });
      }
    } else {
      diagnostics.push({
        severity: "info",
        code: "widget_preview_approximate",
        message:
          "widget previews are drawn by the built-in layout mirror (approximate: no launcher chrome). Attach a native renderer (VELLUM_WIDGET_RENDERER_URL / VELLUM_WIDGET_RENDERER_CMD) for launcher-accurate screenshots.",
        target: "widget"
      });
    }
  }

  const review: ReviewRecord = {
    id: reviewId,
    draftId: job.draftId,
    draftVersion: job.draftVersion,
    contentHash: hash,
    rendererVersion: RENDERER_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    profiles: results.map((r) => r.profile),
    diagnostics,
    screenshots,
    datasetSnapshots,
    status: computeStatus(diagnostics),
    createdAt: Date.now()
  };

  insertReview(review);
  markJobDone(job.id, reviewId);
  console.log(
    `[preview-worker] job ${job.id} done -> review ${reviewId} (${review.status}, ${screenshots.length} screenshots, ${diagnostics.length} diagnostics)`
  );
}

function safeParseProfiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function processJob(job: PreviewJobRow): Promise<void> {
  activeJobId = job.id;
  console.log(
    `[preview-worker] claimed job ${job.id} (draft ${job.draftId} v${job.draftVersion}, attempt ${job.attempts})`
  );
  try {
    const work = runJob(job);
    // After an overall-timeout the background runJob continues briefly and
    // then fails on the closed browser; swallow that rejection and let
    // closeBrowser() below cut it short.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`job timeout after ${jobTimeoutMs}ms`)),
            jobTimeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      work.catch(() => undefined);
    }
  } catch (err) {
    if (shuttingDown) {
      // Shutdown interrupted the job: hand it back to the queue.
      releaseJobToQueued(job.id);
      console.log(`[preview-worker] job ${job.id} released back to queued (shutdown)`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      markJobFailed(job.id, message);
      console.error(`[preview-worker] job ${job.id} failed: ${message}`);
    }
    await closeBrowser(); // discard a possibly-broken browser; next job relaunches
  } finally {
    activeJobId = null;
  }
}

// ---------------------------------------------------------------------------
// Poll loop + graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
let activeJobId: string | null = null;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[preview-worker] ${signal} received, shutting down`);
  if (activeJobId) {
    releaseJobToQueued(activeJobId);
    console.log(`[preview-worker] released running job ${activeJobId} back to queued`);
  }
  void closeBrowser().then(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  // Hard exit if browser close hangs.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log(
    `[preview-worker] polling every ${pollIntervalMs}ms; renderer=${rendererUrl}; artifacts=${artifactDir}` +
      `; widgetRenderer=${
        widgetRendererUrl ? `sidecar ${widgetRendererUrl}` : widgetRendererCmd ? "command" : "none"
      }`
  );
  // Publish the capability so dashboard_context can tell the agent whether a
  // widget design will actually be reviewed before it publishes.
  try {
    setMeta("widget_renderer", widgetRendererCmd || widgetRendererUrl ? "available" : "unavailable");
    setMeta("widget_renderer_checked_at", String(Date.now()));
  } catch (err) {
    console.error(`[preview-worker] could not record widget renderer capability: ${err}`);
  }
  while (!shuttingDown) {
    let job: PreviewJobRow | undefined;
    try {
      job = claimNextJob();
    } catch (err) {
      console.error(`[preview-worker] claim failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (job) {
      await processJob(job);
    } else {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

void main();
