#!/usr/bin/env node
/**
 * Publish an agent-designed launcher-widget presentation for the live dashboard
 * through the normal guarded flow (architecture §4/§11 — no bypassing review):
 *
 *   context -> draft from the current publication + setWidget
 *           -> preview (requires a running preview worker)
 *           -> publish with the returned reviewId
 *
 * Usage:
 *   node scripts/publish-widget.mjs <datasetId> [--server http://host:8787]
 *
 * Env: VELLUM_SERVER (default http://localhost:8787),
 *      VELLUM_AGENT_TOKEN (default agent-dev-token)
 */
const argServer = process.argv.indexOf("--server");
const SERVER = argServer >= 0 ? process.argv[argServer + 1] : process.env.VELLUM_SERVER || "http://localhost:8787";
const AGENT_TOKEN = process.env.VELLUM_AGENT_TOKEN || "agent-dev-token";
const datasetId = process.argv[2];
if (!datasetId) {
  console.error("usage: node scripts/publish-widget.mjs <datasetId> [--server url]");
  process.exit(2);
}

async function agent(method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${AGENT_TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 300)}`);
  return json;
}

/** First image component in a design tree (main tree only). */
function findFirstImage(content) {
  if (!content || !content.root) return null;
  const stack = [content.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "image" && node.props && typeof node.props.assetId === "string") {
      return { assetId: node.props.assetId, alt: node.props.alt };
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return null;
}

async function main() {
  const ctx = await agent("POST", "/api/agent/context", { includeDesign: true });
  console.log(`published revision: ${ctx.published?.revision ?? "none"}`);

  const known = new Set(ctx.datasets.map((d) => d.id));
  if (!known.has(datasetId)) throw new Error(`dataset "${datasetId}" not found (have: ${[...known].join(", ")})`);

  // Widget spec: title + the dataset's list (unchecked first, remaining count)
  // + open-dashboard action — a starting point the agent would refine.
  //
  // Images live in the main tree and do NOT appear on the launcher unless the
  // widget spec references them, so the first image of the dashboard is carried
  // over here (use --no-image to skip it).
  const components = [
    { kind: "text", text: datasetId, emphasis: "title" },
    { kind: "list", dataset: datasetId, maxItems: 4, filter: "unchecked", showRemainingCount: true }
  ];
  if (!process.argv.includes("--no-image")) {
    const firstImage = findFirstImage(ctx.published?.content ?? ctx.draft?.content);
    if (firstImage) {
      components.push({ kind: "image", assetId: firstImage.assetId, alt: firstImage.alt ?? "dashboard image" });
      console.log(`including image ${firstImage.assetId} in the widget spec`);
    }
  }
  components.push({ kind: "action", label: "Open dashboard", action: { kind: "openDashboard" } });
  const widget = {
    components,
    datasets: [datasetId]
  };

  const current = ctx.draft?.content?.datasets ?? ctx.published?.content?.datasets ?? [];
  const datasets = [...new Set([...current, datasetId])];

  const edit = await agent("POST", "/api/agent/edit", {
    base: "current",
    patches: [
      { op: "setWidget", widget },
      { op: "setDatasets", datasets }
    ]
  });
  if (!edit.valid) throw new Error(`draft invalid: ${JSON.stringify(edit.diagnostics)}`);
  console.log(`draft ${edit.draftId} v${edit.version} — requesting preview`);

  // Preview + poll (exact-version review, same semantics as the MCP tool).
  const first = await agent("POST", "/api/agent/preview", { draftId: edit.draftId });
  let job = first;
  const deadline = Date.now() + 150_000;
  while ((job.status === "queued" || job.status === "running") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    job = await agent("POST", "/api/agent/preview", { jobId: job.jobId });
  }
  if (job.status === "failed" || !job.review) throw new Error(`preview ${job.status}${job.error ? ": " + job.error : ""}`);
  if (job.review.status === "failed") throw new Error(`review failed: ${JSON.stringify(job.review.diagnostics)}`);
  console.log(`review ${job.review.id} (${job.review.status}, ${job.review.screenshots?.length ?? 0} screenshots)`);

  const pub = await agent("POST", "/api/agent/publish", {
    draftId: edit.draftId,
    reviewId: job.review.id,
    expectedPublishedRevision: ctx.published?.revision ?? null,
    idempotencyKey: `publish-widget-${datasetId}-${Date.now()}`
  });
  console.log(`published revision ${pub.publication.revision} — wait for the widget's next sync (or reopen Vellum)`);
}

main().catch((e) => {
  console.error("publish-widget:", e.message);
  process.exit(1);
});