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
  /** assetId -> inlined data: URL so screenshots contain the real image. */
  assets?: Record<string, string>;
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

/**
 * Inlining bounds. Assets are embedded as data: URLs so reviewed screenshots
 * contain the real image, but the spec must stay a sane size for the browser
 * and for the worker's own memory.
 */
export const MAX_INLINE_ASSET_BYTES = 1_000_000;
export const MAX_INLINE_TOTAL_BYTES = 4_000_000;

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

/** Every asset id referenced by image components (main tree and widget spec). */
export function collectAssetIds(content: DesignContent): string[] {
  const ids = new Set<string>();
  walk(content.root, (node) => {
    if (node.type === "image") {
      const assetId = (node.props ?? {})["assetId"];
      if (typeof assetId === "string" && assetId.length > 0) ids.add(assetId);
    }
  });
  for (const component of content.widget?.components ?? []) {
    if (component.kind === "image" && component.assetId) ids.add(component.assetId);
  }
  return [...ids];
}

/**
 * Fetch uploaded assets and inline them as data: URLs. Previews must not hit
 * the network while rendering (the sandbox renders one self-contained spec),
 * but a screenshot with placeholder boxes is useless evidence — so the bytes
 * are embedded before rendering.
 */
export async function inlineAssets(
  serverUrl: string,
  token: string,
  assetIds: string[]
): Promise<{ assets: Record<string, string>; diagnostics: Diagnostic[] }> {
  const assets: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  const origin = new URL(serverUrl).origin;
  let inlinedBytes = 0;
  for (const assetId of assetIds) {
    try {
      const res = await fetch(`${origin}/api/assets/${encodeURIComponent(assetId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        diagnostics.push({
          severity: "warning",
          code: "asset_unavailable",
          message: `image asset "${assetId}" could not be loaded (HTTP ${res.status})`
        });
        continue;
      }
      const mime = res.headers.get("content-type") ?? "image/png";
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_INLINE_ASSET_BYTES || inlinedBytes + bytes.length > MAX_INLINE_TOTAL_BYTES) {
        diagnostics.push({
          severity: "warning",
          code: "asset_not_inlined",
          message: `image asset "${assetId}" (${bytes.length} bytes) is too large to inline for preview — the screenshot renders a placeholder for it`
        });
        continue;
      }
      inlinedBytes += bytes.length;
      assets[assetId] = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch (err) {
      diagnostics.push({
        severity: "warning",
        code: "asset_unavailable",
        message: `image asset "${assetId}" could not be loaded: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  return { assets, diagnostics };
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
    const raw = route.request().url();
    // Inlined assets arrive as data: URLs (origin "null") — self-contained, no
    // network, and must not be aborted by the sandbox below.
    if (raw.startsWith("data:") || raw.startsWith("blob:")) {
      void route.continue().catch(() => undefined);
      return;
    }
    let origin: string;
    try {
      origin = new URL(raw).origin;
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
    // The spec is injected before navigation instead of passed in the query
    // string: inlined image assets make specs far larger than the server's
    // HTTP header limit (Node default 16 KB), which fails the page load with
    // 431 and times every profile out.
    const specJson = JSON.stringify(spec)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    await page.addInitScript({ content: `window.__vellumSpec = ${specJson};` });

    const url = `${rendererUrl.replace(/\/$/, "")}/preview.html`;
    let ready = true;
    try {
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
    } catch (err) {
      // Never fail silently with zero artifacts: record why, and still capture
      // whatever the page shows so the agent has evidence to look at.
      ready = false;
      diagnostics.push({
        severity: "error",
        code: "preview_timeout",
        message: `page did not become ready: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000),
        target: profile.name
      });
    }

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

    // Overflow and interaction checks need a mounted page.
    if (!ready) {
      return { profile: profile.name, target: profile.target, screenshot, diagnostics };
    }

    // Evidence check: every image actually rendered (an inlined asset that the
    // sandbox aborted, or a missing asset, shows as a broken image otherwise).
    const brokenImages = (await page.evaluate(`(() => {
      const out = [];
      for (const img of Array.from(document.images)) {
        if (!img.complete || img.naturalWidth === 0) {
          out.push(img.getAttribute("data-component-id") || img.getAttribute("alt") || "image");
        }
      }
      return out;
    })()`)) as string[];
    for (const componentId of brokenImages) {
      diagnostics.push({
        severity: "warning",
        code: "image_not_rendered",
        message: "image did not render in the preview (broken or aborted source)",
        componentId,
        target: profile.name
      });
    }

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
  profiles: TargetProfile[],
  assets: Record<string, string> = {}
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
        profile: profile.name,
        assets
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
