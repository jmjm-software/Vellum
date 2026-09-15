#!/usr/bin/env node
/**
 * Smoke test for the native widget renderer (sidecar or local script).
 *
 *   node scripts/widget-renderer-smoke.mjs                        # local script mode
 *   VELLUM_WIDGET_RENDERER_URL=http://localhost:8790 node scripts/widget-renderer-smoke.mjs
 *
 * Renders a fixture widget through the real native renderer and asserts that
 * valid PNGs come back — this is what CI runs against the built sidecar image.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const url = process.env.VELLUM_WIDGET_RENDERER_URL ?? "";
const script = process.env.VELLUM_RENDER_SCRIPT ?? join(repoRoot, "scripts", "render-widget-previews.sh");

const spec = {
  serverTime: Date.now(),
  publication: {
    revision: 1,
    contentHash: "smoke",
    publishedAt: Date.now(),
    content: {
      widget: {
        components: [
          { kind: "text", text: "Shopping", emphasis: "title" },
          { kind: "list", dataset: "shopping", maxItems: 3, filter: "unchecked", showRemainingCount: true },
          { kind: "image", assetId: "asset_smoke", alt: "Smoke image", size: "large" },
          { kind: "action", label: "Open dashboard", action: { kind: "openDashboard" } }
        ],
        datasets: ["shopping"]
      }
    }
  },
  datasets: [
    {
      id: "shopping",
      title: "Shopping",
      ownership: "dashboard",
      version: 1,
      updatedAt: Date.now(),
      value: {
        kind: "list",
        items: [
          { id: "a", label: "Apples", done: false },
          { id: "b", label: "Bread", done: true },
          { id: "c", label: "Coffee", done: false }
        ]
      }
    }
  ],
  // Contents are irrelevant for the smoke test (the widget only needs the file
  // to exist); the renderer never decodes in this path beyond what it is given.
  assets: { asset_smoke: "AQIDBA==" }
};

function pngInfo(base64) {
  const raw = Buffer.from(base64, "base64");
  const isPng = raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { bytes: raw.length, isPng, width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
}

async function request(extra = {}) {
  const res = await fetch(`${url.replace(/\/$/, "")}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec }),
    ...extra
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  let files = [];
  if (url) {
    const { status, body } = await request();
    if (status !== 200) throw new Error(`renderer HTTP ${status}: ${body.error ?? JSON.stringify(body).slice(0, 300)}`);
    files = body.files ?? [];
  } else {
    const dir = mkdtempSync(join(tmpdir(), "vellum-smoke-"));
    const { mkdtempSync: mk, writeFileSync } = await import("node:fs");
    const out = mk(join(dir, "out-"));
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
    await new Promise((resolve, reject) => {
      execFile("bash", [script, join(dir, "spec.json"), out], { timeout: 300_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`renderer failed: ${stderr || stdout || err.message}`));
        else resolve();
      });
    });
    files = readdirSync(out)
      .filter((f) => f.endsWith(".png"))
      .map((name) => ({ name, base64: readFileSync(join(out, name)).toString("base64") }));
    rmSync(dir, { recursive: true, force: true });
  }

  if (files.length === 0) throw new Error("renderer produced no previews");
  let ok = true;
  for (const file of files) {
    const info = pngInfo(file.base64);
    const valid = info.isPng && info.width > 0 && info.height > 0 && info.bytes > 1000;
    console.log(`  ${valid ? "ok  " : "FAIL"} ${file.name}: ${info.bytes} bytes, ${info.width}x${info.height}`);
    if (!valid) ok = false;
  }
  if (!ok) throw new Error("renderer produced invalid previews");
  console.log(`WIDGET_RENDERER_SMOKE_OK (${files.length} previews${url ? ` via ${url}` : " via local script"})`);
}

main().catch((err) => {
  console.error("widget renderer smoke failed:", err.message);
  process.exit(1);
});
