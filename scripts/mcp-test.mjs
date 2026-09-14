import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve everything relative to this script so the test runs from any checkout
// and any cwd; use the running node binary instead of relying on PATH.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "packages", "server", "dist", "mcp-stdio.js")],
  cwd: repoRoot,
  env: { ...process.env, VELLUM_DATA_DIR: process.env.VELLUM_DATA_DIR ?? "/tmp/vellum-e2e" }
});
const client = new Client({ name: "e2e-harness", version: "1.0.0" });
const initResult = await client.connect(transport);

const info = client.getServerVersion();
console.log("server:", info?.name, info?.version);
const instructions = initResult?.instructions ?? client.getInstructions?.() ?? "";
console.log("instructions present:", instructions.length > 100, `(${instructions.length} chars)`);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

// 1. context
let ctx = await client.callTool({ name: "dashboard_context", arguments: {} });
let ctxJson = JSON.parse(ctx.content[0].text);

// Self-seed when running against a fresh database: exercises dashboard_data and
// dashboard_edit over MCP as part of the integration test.
if (!ctxJson.draft) {
  await client.callTool({
    name: "dashboard_data",
    arguments: {
      op: "create",
      definition: { id: "shopping", title: "Shopping list", ownership: "dashboard", schema: { kind: "list" } },
      value: {
        kind: "list",
        items: [
          { id: "milk", label: "Milk", done: false },
          { id: "bread", label: "Bread", done: false },
          { id: "coffee", label: "Coffee beans", done: true }
        ]
      }
    }
  });
  const edit = await client.callTool({
    name: "dashboard_edit",
    arguments: {
      base: "blank",
      patches: [
        {
          op: "replaceRoot",
          root: {
            id: "root",
            type: "grid",
            props: { columns: 12, gap: 12 },
            children: [
              {
                id: "shopping-panel",
                type: "card",
                props: { title: "Shopping" },
                children: [{ id: "shopping-list", type: "checklist", props: { dataset: "shopping", maxVisible: 6, overflow: "showMore" } }]
              }
            ]
          }
        },
        { op: "setDatasets", datasets: ["shopping"] },
        { op: "setIntent", intent: { purpose: "MCP integration test dashboard" } }
      ]
    }
  });
  const editJson = JSON.parse(edit.content[0].text);
  if (!editJson.valid) throw new Error(`self-seed edit invalid: ${JSON.stringify(editJson.diagnostics)}`);
  ctx = await client.callTool({ name: "dashboard_context", arguments: {} });
  ctxJson = JSON.parse(ctx.content[0].text);
}
console.log("context: published rev", ctxJson.published?.revision, "| datasets:", ctxJson.datasets.map((d) => d.id).join(","), "| draft:", ctxJson.draft?.id, "v" + ctxJson.draft?.version);

// 2. data read
const data = await client.callTool({ name: "dashboard_data", arguments: { op: "get", datasetId: "shopping" } });
const dataJson = JSON.parse(data.content[0].text);
console.log("data: shopping items:", dataJson.dataset?.value?.items?.length ?? JSON.parse(dataJson.content?.[0]?.text ?? "{}")?.dataset?.value?.items?.length);

// 3. preview the existing draft — poll the job until done (exact-version review)
const draftId = ctxJson.draft.id;
let prevJson = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const prev = await client.callTool({ name: "dashboard_preview", arguments: { draftId } });
  prevJson = JSON.parse(prev.content.find((c) => c.type === "text").text);
  if (prevJson.status === "done" || prevJson.status === "failed") {
    const kinds = prev.content.map((c) => c.type);
    console.log("preview content block types:", kinds.join(","), "(images:", kinds.filter((k) => k === "image").length + ")");
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("preview status:", prevJson?.status, "| review:", prevJson?.reviewId, prevJson?.reviewStatus, "| screenshots:", prevJson?.screenshots?.length, "| diagnostics:", prevJson?.diagnostics?.length);
console.log("nextStep:", prevJson?.nextStep?.slice(0, 120));

// 4. events
const ev = await client.callTool({ name: "dashboard_events", arguments: { op: "list", limit: 5 } });
const evJson = JSON.parse(ev.content[0].text);
console.log("events:", evJson.events?.length, "total listed");

// 5. publish guard via MCP: stale review must be rejected
const pub = await client.callTool({
  name: "dashboard_publish",
  arguments: { draftId, reviewId: prevJson.reviewId, expectedPublishedRevision: 999, idempotencyKey: "mcp-test-bad" }
}, undefined);
console.log("publish with wrong revision isError:", pub.isError === true);

await client.close();
console.log("MCP_TEST_DONE");
