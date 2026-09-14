import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/server/dist/mcp-stdio.js"],
  cwd: "/home/josh/projects/vellum",
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
const ctx = await client.callTool({ name: "dashboard_context", arguments: {} });
const ctxJson = JSON.parse(ctx.content[0].text);
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
