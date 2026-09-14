/**
 * Per-profile rendering + diagnostics against the web app's isolated
 * preview page (`/preview.html?spec=<base64url json>`).
 *
 * Every profile gets a fresh page (isolation); at most MAX_CONCURRENT_PAGES
 * pages are open at once against a single reused browser.
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Browser, Page } from "playwright";
import type {
  ComponentNode,
  Dataset,
  DesignContent,
  Diagnostic,
  ListItem,
  ScreenshotArtifact,
  TargetKind,
  TargetProfile
} from "@vellum/core/types.js";

export const MAX_CONCURRENT_PAGES = 2;
export const PROFILE_TIMEOUT_MS = 60_000;
export const READY_TIMEOUT_MS = 60_000;

export interface RenderSpec {
  content: DesignContent;
  datasets: Dataset[];
  target: TargetKind;
  profile: string;
}

export interface ProfileResult {
  profile: string;
  target: TargetKind;
  screenshot?: ScreenshotArtifact;
  diagnostics: Diagnostic[];
}

function encodeSpec(spec: RenderSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

/** Read width/height out of a PNG buffer's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Checklist interaction test
// ---------------------------------------------------------------------------

interface ChecklistTarget {
  componentId: string;
  datasetId: string;
  expectedItemId: string;
}

function walk(node: ComponentNode | undefined, fn: (n: ComponentNode) => void): void {
  if (!node) return;
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
}

/**
 * Find every checklist component bound to a non-empty list dataset and
 * compute the itemId the renderer will show in the FIRST row of each. The
 * renderer (components.tsx ChecklistComponent) filters out done items when
 * `showCompleted === false` and then stable-sorts done items last — replicate
 * that so we know which itemId a first-row click must produce.
 */
function findChecklistTargets(content: DesignContent, datasets: Dataset[]): ChecklistTarget[] {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const targets: ChecklistTarget[] = [];
  walk(content.root, (node) => {
    if (node.type !== "checklist") return;
    const props = (node.props ?? {}) as {
      dataset?: string;
      showCompleted?: boolean;
    };
    const ds = props.dataset ? byId.get(props.dataset) : undefined;
    if (!ds || ds.schema.kind !== "list" || ds.value.kind !== "list") return;
    let items: ListItem[] = [...ds.value.items];
    if (props.showCompleted === false) items = items.filter((i) => !i.done);
    items = [...items].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    if (items.length === 0) return;
    targets.push({ componentId: node.id, datasetId: ds.id, expectedItemId: items[0]!.id });
  });
  return targets;
}

interface RecordedAction {
  action?: { kind?: string; dataset?: string; itemId?: string };
  ctx?: { componentId?: string };
}

async function runInteractionTest(
  page: Page,
  target: ChecklistTarget,
  profileName: string
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const rowSelector = `[data-component-id="${target.componentId}"] .vellum-checklist-row`;
  const boxSelector = `${rowSelector} .vellum-checklist-box`;
  try {
    const box = page.locator(boxSelector).first();
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.click({ timeout: 5000 });
    // Give React a tick to flush the onAction callback into the recorder.
    // String form: the worker tsconfig has no DOM lib.
    await page
      .waitForFunction(
        "Array.isArray(window.__vellumActions) && window.__vellumActions.length > 0",
        undefined,
        { timeout: 5000 }
      )
      .catch(() => undefined);
    const actions = (await page.evaluate(
      "window.__vellumActions || []"
    )) as RecordedAction[];
    const ok = actions.some(
      (a) =>
        a?.action?.kind === "toggleItem" &&
        a.action.itemId === target.expectedItemId &&
        a.action.dataset === target.datasetId &&
        a?.ctx?.componentId === target.componentId
    );
    if (!ok) {
      diagnostics.push({
        severity: "error",
        code: "interaction_test_failed",
        message: `Clicking the first checklist row of "${target.componentId}" did not record a toggleItem action for itemId "${target.expectedItemId}" (dataset "${target.datasetId}"). Recorded: ${JSON.stringify(actions).slice(0, 400)}`,
        componentId: target.componentId,
        target: profileName
      });
    }
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "interaction_test_failed",
      message: `Checklist interaction test threw: ${err instanceof Error ? err.message : String(err)}`,
      componentId: target.componentId,
      target: profileName
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// One profile
// ---------------------------------------------------------------------------

export async function runProfile(
  browser: Browser,
  rendererUrl: string,
  reviewId: string,
  artifactDir: string,
  spec: RenderSpec,
  profile: TargetProfile,
  checklistTargets: ChecklistTarget[]
): Promise<ProfileResult> {
  const diagnostics: Diagnostic[] = [];
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor ?? 1
  });
  const page = await context.newPage();

  // Hard sandbox: abort every request that is not served by the renderer
  // origin itself. The preview page must never reach real endpoints.
  const rendererOrigin = new URL(rendererUrl).origin;
  await page.route("**/*", (route) => {
    let origin: string;
    try {
      origin = new URL(route.request().url()).origin;
    } catch {
      void route.abort().catch(() => undefined);
      return;
    }
    if (origin === rendererOrigin) void route.continue().catch(() => undefined);
    else void route.abort().catch(() => undefined);
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Chromium logs favicon 404s as console errors; not app runtime errors.
    if (/favicon/i.test(text)) return;
    diagnostics.push({
      severity: "error",
      code: "runtime_error",
      message: `console error: ${text}`.slice(0, 1000),
      target: profile.name
    });
  });
  page.on("pageerror", (err) => {
    diagnostics.push({
      severity: "error",
      code: "runtime_error",
      message: `page error: ${err.message}`.slice(0, 1000),
      target: profile.name
    });
  });

  try {
    const url = `${rendererUrl.replace(/\/$/, "")}/preview.html?spec=${encodeSpec(spec)}`;
    await withTimeout(
      (async () => {
        await page.goto(url, { waitUntil: "load", timeout: READY_TIMEOUT_MS });
        await page.waitForFunction("window.__vellumReady === true", undefined, {
          timeout: READY_TIMEOUT_MS
        });
      })(),
      READY_TIMEOUT_MS + 5000,
      `profile ${profile.name}: page load`
    );

    // Screenshot (fullPage png) -> <artifactDir>/reviews/<reviewId>/<profile>.png
    const dir = join(artifactDir, "reviews", reviewId);
    mkdirSync(dir, { recursive: true });
    const absPath = join(dir, `${profile.name}.png`);
    const buf = await page.screenshot({ path: absPath, fullPage: true, type: "png" });
    const size = pngSize(buf as unknown as Buffer);
    const screenshot: ScreenshotArtifact = {
      profile: profile.name,
      target: profile.target,
      path: relative(artifactDir, absPath),
      width: size.width,
      height: size.height
    };

    // Overflow check across every rendered component root.
    const overflowing = (await page.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll("[data-component-id]")) {
        if (el.scrollWidth > el.clientWidth + 2) {
          out.push(el.getAttribute("data-component-id") || "");
        }
      }
      return out;
    })()`)) as string[];
    for (const componentId of overflowing) {
      diagnostics.push({
        severity: "warning",
        code: "possible_horizontal_overflow",
        message: "possible horizontal overflow: scrollWidth exceeds clientWidth by more than 2px",
        componentId,
        target: profile.name
      });
    }

    // Sandboxed checklist interaction tests (recorder only; no real data).
    for (const checklistTarget of checklistTargets) {
      diagnostics.push(...(await runInteractionTest(page, checklistTarget, profile.name)));
    }

    return { profile: profile.name, target: profile.target, screenshot, diagnostics };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Run all profiles for one job, max MAX_CONCURRENT_PAGES pages at once. */
export async function runAllProfiles(
  browser: Browser,
  rendererUrl: string,
  reviewId: string,
  artifactDir: string,
  content: DesignContent,
  datasets: Dataset[],
  profiles: TargetProfile[]
): Promise<ProfileResult[]> {
  const checklistTargets = findChecklistTargets(content, datasets);
  const results: ProfileResult[] = [];
  let next = 0;
  async function workerLoop(): Promise<void> {
    while (next < profiles.length) {
      const profile = profiles[next++]!;
      const spec: RenderSpec = {
        content,
        datasets,
        target: profile.target,
        profile: profile.name
      };
      try {
        results.push(
          await withTimeout(
            runProfile(
              browser,
              rendererUrl,
              reviewId,
              artifactDir,
              spec,
              profile,
              checklistTargets
            ),
            PROFILE_TIMEOUT_MS,
            `profile ${profile.name}`
          )
        );
      } catch (err) {
        results.push({
          profile: profile.name,
          target: profile.target,
          diagnostics: [
            {
              severity: "error",
              code: "profile_failed",
              message: `Profile render failed: ${err instanceof Error ? err.message : String(err)}`,
              target: profile.name
            }
          ]
        });
      }
    }
  }
  const lanes = Array.from(
    { length: Math.min(MAX_CONCURRENT_PAGES, profiles.length) },
    () => workerLoop()
  );
  await Promise.all(lanes);
  // Preserve profile order regardless of completion order.
  const byName = new Map(results.map((r) => [r.profile, r]));
  return profiles.map((p) => byName.get(p.name)!).filter(Boolean);
}
