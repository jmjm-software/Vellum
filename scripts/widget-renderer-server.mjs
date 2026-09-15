#!/usr/bin/env node
/**
 * Native widget renderer sidecar.
 *
 * Serves the native Glance widget renderer over HTTP so the dashboard's preview
 * worker can produce widget screenshots even when it runs in a container that
 * has no JDK/Android SDK (the usual case):
 *
 *   POST /render   { spec: <state-shaped widget payload> }  -> { files: [{ name, base64 }] }
 *   GET  /health                                            -> { ok, renderer, queue }
 *
 * The heavy lifting is scripts/render-widget-previews.sh (Gradle + Robolectric +
 * the real Glance RemoteViews). Renders are serialized: Gradle builds one at a
 * time, and the widget preview is a review step, not a hot path.
 *
 * Env:
 *   PORT                        default 8790
 *   VELLUM_RENDER_SCRIPT        default <repo>/scripts/render-widget-previews.sh
 *   VELLUM_RENDER_TIMEOUT_MS    default 300000
 *   VELLUM_RENDER_QUEUE_LIMIT   default 8 (requests) before 429
 */
import { createServer } from "node:http";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const PORT = Number(process.env.PORT ?? 8790);
const RENDER_SCRIPT = process.env.VELLUM_RENDER_SCRIPT ?? join(repoRoot, "scripts", "render-widget-previews.sh");
const TIMEOUT_MS = Number(process.env.VELLUM_RENDER_TIMEOUT_MS ?? 300_000);
const QUEUE_LIMIT = Number(process.env.VELLUM_RENDER_QUEUE_LIMIT ?? 8);

let running = 0;
let queued = 0;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function render(spec) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-widget-"));
    const specPath = join(dir, "widget-spec.json");
    const outDir = join(dir, "out");
    writeFileSync(specPath, JSON.stringify(spec));

    // Run the script directly so its shebang (bash) applies: invoking it as
    // `sh script` would parse it with dash, which rejects `set -o pipefail`.
    const executable = isExecutable(RENDER_SCRIPT);
    const child = executable
      ? spawn(RENDER_SCRIPT, [specPath, outDir], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
      : spawn("bash", [RENDER_SCRIPT, specPath, outDir], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let log = "";
    child.stdout?.on("data", (c) => (log += String(c)));
    child.stderr?.on("data", (c) => (log += String(c)));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1, "renderer timed out");
    }, TIMEOUT_MS);

    function finish(code, extraError) {
      clearTimeout(timer);
      let files = [];
      try {
        files = readdirSync(outDir)
          .filter((f) => f.endsWith(".png"))
          .sort()
          .map((name) => ({ name, base64: readFileSync(join(outDir, name)).toString("base64") }));
      } catch {
        /* no output dir */
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, files, log: log.slice(-4000), error: extraError });
    }

    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (err) => finish(-1, `spawn failed: ${err.message}`));
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.method === "GET" && url.pathname === "/health") {
    return send(200, { ok: true, renderer: RENDER_SCRIPT, running, queued });
  }

  if (req.method === "POST" && url.pathname === "/render") {
    if (queued + running >= QUEUE_LIMIT) return send(429, { error: "renderer queue is full" });
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8_000_000) req.destroy(); // guard: specs are small
    });
    req.on("end", async () => {
      let spec;
      try {
        spec = JSON.parse(body).spec;
        if (!spec || typeof spec !== "object") throw new Error("spec is required");
      } catch (err) {
        return send(400, { error: `bad request: ${err.message}` });
      }
      queued++;
      try {
        const result = await render(spec);
        if (result.code !== 0 || result.files.length === 0) {
          return send(500, {
            error: result.error ?? `renderer exited ${result.code} without previews`,
            log: result.log,
            files: result.files.map((f) => f.name)
          });
        }
        send(200, { files: result.files, log: result.log });
      } finally {
        queued--;
      }
    });
    return;
  }

  send(404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[widget-renderer] listening on :${PORT} (script: ${RENDER_SCRIPT})`);
});
