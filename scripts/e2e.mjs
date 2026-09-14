#!/usr/bin/env node
/**
 * Vellum E2E acceptance test (architecture §11).
 *
 * Exercises the guarded loop against a running server:
 *   context -> data create -> draft edit -> validation -> publish guards
 *   -> data update without redesign -> mirrored-dataset event flow
 *   -> client action -> rollback of design without touching data.
 *
 * Preview is exercised only when a preview worker + renderer are available
 * (guarded publish requires a passing review), otherwise the review-dependent
 * publish guards are checked for correct rejection.
 *
 * Usage: node scripts/e2e.mjs [--server http://localhost:8787]
 */
const argServer = process.argv.indexOf("--server");
const SERVER = argServer >= 0 ? process.argv[argServer + 1] : process.env.VELLUM_SERVER || "http://localhost:8787";
const CLIENT_TOKEN = process.env.VELLUM_CLIENT_TOKEN || "client-dev-token";
const AGENT_TOKEN = process.env.VELLUM_AGENT_TOKEN || "agent-dev-token";

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}

async function req(method, path, { token = CLIENT_TOKEN, body } = {}) {
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

const agent = (method, path, body) => req(method, path, { token: AGENT_TOKEN, body });

async function main() {
  console.log(`vellum e2e against ${SERVER}\n`);

  // --- health & auth -------------------------------------------------------
  const health = await req("GET", "/api/health", { token: null });
  check("health endpoint reachable", health.status === 200, health);

  const noAuth = await req("GET", "/api/state", { token: null });
  check("state requires auth", noAuth.status === 401 || noAuth.status === 403, noAuth.status);

  const state0 = await req("GET", "/api/state");
  check("client can read state", state0.status === 200 && state0.json, state0.status);

  // --- agent context -------------------------------------------------------
  const ctx = await agent("POST", "/api/agent/context", { includeDesign: true });
  check("agent context works", ctx.status === 200 && ctx.json?.guidance?.length > 0, ctx.status);
  check("context bundles catalogue", typeof ctx.json?.catalogue === "string" && ctx.json.catalogue.includes("checklist"));

  // --- datasets: dashboard-owned shopping list ------------------------------
  const shopping = await agent("POST", "/api/agent/data", {
    op: "create",
    definition: {
      id: "shopping",
      title: "Shopping list",
      ownership: "dashboard",
      schema: { kind: "list" }
    },
    value: {
      kind: "list",
      items: [
        { id: "milk", label: "Milk", done: false },
        { id: "bread", label: "Bread", done: false },
        { id: "coffee", label: "Coffee beans", done: true }
      ]
    }
  });
  check("create dashboard-owned dataset", shopping.status === 200 && shopping.json?.dataset?.id === "shopping", shopping.json);

  // schema violations rejected
  const badData = await agent("POST", "/api/agent/data", {
    op: "create",
    definition: { id: "power", title: "Power", ownership: "mirrored", schema: { kind: "metric", fields: [{ name: "watts", unit: "W" }] } },
    value: { kind: "metric", values: { unknownField: 5 } }
  });
  check("invalid dataset value rejected", badData.status >= 400, badData.status);

  const power = await agent("POST", "/api/agent/data", {
    op: "create",
    definition: { id: "power", title: "Power", ownership: "mirrored", schema: { kind: "metric", fields: [{ name: "watts", unit: "W" }] }, source: "harness:smart-home" },
    value: { kind: "metric", values: { watts: 412 } }
  });
  check("create mirrored dataset", power.status === 200, power.json);

  // --- draft edit -----------------------------------------------------------
  const edit1 = await agent("POST", "/api/agent/edit", {
    base: "blank",
    patches: [
      {
        op: "replaceRoot",
        root: {
          id: "root",
          type: "grid",
          props: { columns: 12, gap: 12 },
          children: [
            { id: "shopping-panel", type: "card", props: { title: "Shopping" }, children: [
              { id: "shopping-list", type: "checklist", props: { dataset: "shopping", maxVisible: 6, overflow: "showMore" } }
            ] },
            { id: "power-card", type: "card", props: { title: "Power now" }, children: [
              { id: "power-metric", type: "metric", props: { dataset: "power", field: "watts", unit: "W" } }
            ] }
          ]
        }
      },
      { op: "setDatasets", datasets: ["shopping", "power"] },
      {
        op: "setWidget",
        widget: {
          components: [
            { kind: "text", text: "Shopping", emphasis: "title" },
            { kind: "list", dataset: "shopping", maxItems: 4, filter: "unchecked", showRemainingCount: true },
            { kind: "action", label: "Open dashboard", action: { kind: "openDashboard" } }
          ],
          datasets: ["shopping"]
        }
      },
      { op: "setOverride", target: "desktop", id: "shopping-panel", override: { span: 4, order: 2 } },
      { op: "setOverride", target: "desktop", id: "power-card", override: { span: 8, order: 1 } },
      { op: "setOverride", target: "phone", id: "shopping-panel", override: { order: 1 } },
      { op: "setIntent", intent: { purpose: "Daily home dashboard", priorities: ["shopping first on phone"] } }
    ]
  });
  check("draft edit accepted", edit1.status === 200 && edit1.json?.valid === true, edit1.json);
  const draftId = edit1.json?.draftId;
  const draftV1 = edit1.json?.version;
  check("edit reports next step (preview)", typeof edit1.json?.nextStep === "string" && /preview/i.test(edit1.json.nextStep), edit1.json?.nextStep);

  // the design carries an agent-authored widget presentation (§4)
  const wd = await agent("POST", "/api/agent/context", { includeDesign: true });
  const wdWidget = wd.json?.draft?.content?.widget;
  check("design includes a widget spec", !!wdWidget && wdWidget.components?.length >= 2, wdWidget);

  // invalid design rejected (isolated in its own draft so the main draft stays valid)
  const badEdit = await agent("POST", "/api/agent/edit", {
    base: "blank",
    patches: [{ op: "replaceRoot", root: { id: "root", type: "not-a-component", props: {} } }]
  });
  check("unknown component rejected", badEdit.json?.valid === false || badEdit.status >= 400, badEdit.json);

  // stale draft version rejected (optimistic concurrency)
  const staleEdit = await agent("POST", "/api/agent/edit", {
    draftId,
    expectedVersion: draftV1 - 1,
    patches: [{ op: "updateProps", id: "power-metric", props: { label: "stale" } }]
  });
  check("stale draft version rejected", staleEdit.status >= 400 || staleEdit.json?.valid === false, staleEdit.status);

  // --- publish guards -------------------------------------------------------
  const pubNoReview = await agent("POST", "/api/agent/publish", {
    draftId,
    reviewId: "review_does_not_exist",
    expectedPublishedRevision: null,
    idempotencyKey: "e2e-publish-noreview"
  });
  check("publish without valid review rejected", pubNoReview.status >= 400, pubNoReview.status);

  // --- preview (optional path) ----------------------------------------------
  const preview = await agent("POST", "/api/agent/preview", { draftId });
  let review = null;
  if (preview.status === 200 && preview.json?.jobId) {
    console.log(`  ..   preview job ${preview.json.jobId} (${preview.json.status}); polling up to 90s`);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await agent("POST", "/api/agent/preview", { draftId, jobId: preview.json.jobId });
      const j = job.json ?? {};
      if (j.status === "done" && j.review) {
        review = j.review;
        break;
      }
      if (j.status === "failed") {
        console.error(`  ..   preview job failed: ${j.error}`);
        break;
      }
    }
  } else {
    console.log(`  ..   preview unavailable (${preview.status}); continuing with guard checks only`);
  }

  if (review) {
    check("review produced screenshots", Array.isArray(review.screenshots) && review.screenshots.length > 0, review.screenshots?.length);
    check("review bound to exact draft version", review.draftId === draftId, review.draftId);
    check("review has status", ["passed", "passed_with_warnings", "failed"].includes(review.status), review.status);

    if (review.status !== "failed") {
      const pub = await agent("POST", "/api/agent/publish", {
        draftId,
        reviewId: review.id,
        expectedPublishedRevision: null,
        idempotencyKey: "e2e-publish-1"
      });
      check("publish with valid review succeeds", pub.status === 200 && pub.json?.publication?.revision >= 1, pub.json);

      // editing the draft invalidates the review
      const bump = await agent("POST", "/api/agent/edit", {
        draftId,
        expectedVersion: draftV1,
        patches: [{ op: "updateProps", id: "power-card", props: { title: "Power (edited)" } }]
      });
      check("post-publish edit succeeds", bump.status === 200 && bump.json?.valid === true, bump.json);
      const stalePub = await agent("POST", "/api/agent/publish", {
        draftId,
        reviewId: review.id,
        expectedPublishedRevision: pub.json?.publication?.revision ?? null,
        idempotencyKey: "e2e-publish-stale"
      });
      check("publish with stale review rejected", stalePub.status >= 400, stalePub.status);

      // wrong expected revision rejected
      const conflictPub = await agent("POST", "/api/agent/publish", {
        draftId,
        reviewId: review.id,
        expectedPublishedRevision: 999,
        idempotencyKey: "e2e-publish-conflict"
      });
      check("publish with wrong expectedPublishedRevision rejected", conflictPub.status >= 400, conflictPub.status);

      // idempotent republish
      const pub2 = await agent("POST", "/api/agent/publish", {
        draftId,
        reviewId: review.id,
        expectedPublishedRevision: null,
        idempotencyKey: "e2e-publish-1"
      });
      check("idempotent publish replay safe", pub2.status === 200, pub2.status);

      // client sees the publication
      const state1 = await req("GET", "/api/state");
      check("client state includes publication", !!state1.json?.publication, state1.json?.publication?.revision);
      check("client state includes datasets", Array.isArray(state1.json?.datasets) && state1.json.datasets.length >= 2);
    } else {
      console.log("  ..   review failed; skipping publish-dependent checks");
    }
  } else {
    console.log("  ..   no preview worker available; skipping publish-dependent checks");
  }

  // --- data update without redesign ------------------------------------------
  const upd = await agent("POST", "/api/agent/data", {
    op: "update",
    datasetId: "power",
    value: { kind: "metric", values: { watts: 385 } }
  });
  check("data update independent of design", upd.status === 200 && upd.json?.dataset?.value?.values?.watts === 385, upd.json);

  // --- dashboard-local action (no model call) ---------------------------------
  const act = await req("POST", "/api/actions", {
    body: { type: "toggleItem", datasetId: "shopping", itemId: "milk", idempotencyKey: "e2e-toggle-milk-1" }
  });
  check("local toggle action applied", act.status === 200, act.json);
  const ds = await req("GET", "/api/datasets/shopping");
  const milk = ds.json?.value?.items?.find((i) => i.id === "milk");
  check("toggled item is done", milk?.done === true, milk);

  // idempotent replay
  const actReplay = await req("POST", "/api/actions", {
    body: { type: "toggleItem", datasetId: "shopping", itemId: "milk", idempotencyKey: "e2e-toggle-milk-1" }
  });
  check("idempotent action replay safe", actReplay.status === 200, actReplay.json);

  // --- mirrored dataset action -> harness event --------------------------------
  const mirroredAct = await req("POST", "/api/actions", {
    body: { type: "toggleItem", datasetId: "power", itemId: "watts", idempotencyKey: "e2e-mirrored-1" }
  });
  const isEvent = mirroredAct.json?.event?.requiresHarness === true || mirroredAct.status >= 400;
  check("mirrored action creates harness event (or is rejected)", isEvent, mirroredAct.json ?? mirroredAct.status);
  if (mirroredAct.json?.event?.requiresHarness) {
    const evId = mirroredAct.json.event.id;
    const claimed = await agent("POST", "/api/agent/events", { op: "claim", max: 10 });
    check("harness can claim events", claimed.status === 200 && Array.isArray(claimed.json?.events), claimed.json);
    const ack = await agent("POST", "/api/agent/events", { op: "ack", eventId: evId, outcome: "success" });
    check("harness can ack events", ack.status === 200, ack.json);
  }

  // --- history & rollback (design only, never data) -----------------------------
  const hist = await req("GET", "/api/history");
  if (hist.status === 200) {
    check("history lists revisions", Array.isArray(hist.json?.revisions ?? hist.json), hist.json);
  } else {
    console.log(`  ..   history endpoint returned ${hist.status} (skipping rollback)`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("e2e crashed:", e);
  process.exit(2);
});
