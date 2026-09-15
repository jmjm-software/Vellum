# @vellum/preview-worker

Playwright-based preview worker for Vellum. It polls the shared SQLite job
queue, renders drafts through the web app's isolated `/preview.html` page
(production renderer, sandboxed data — no network calls, no real actions),
captures per-profile screenshots, runs diagnostics + a checklist interaction
test, and writes a `ReviewRecord` the server requires before publishing.

## Run

```sh
npm run build          # tsc -> dist/
node dist/index.js     # or: npm start
```

The worker must share `VELLUM_DATA_DIR` with the server (same `store.db`),
and the web app's built `preview.html` must be reachable at
`VELLUM_RENDERER_URL` (e.g. `npx vite preview --port 8788` in
`packages/web`, or the server's static mount).

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `VELLUM_DATA_DIR` | `./.vellum-data` | Data dir; db at `<dir>/store.db`, screenshots at `<dir>/artifacts/reviews/<reviewId>/<profile>.png` |
| `VELLUM_RENDERER_URL` | `http://localhost:8788` | Base URL serving `/preview.html` |
| `VELLUM_CLIENT_TOKEN` | `client-dev-token` | Used only to read uploaded assets so they can be inlined into the preview spec (must match the server's client token) |
| `VELLUM_POLL_INTERVAL_MS` | `2000` | Queue poll interval |
| `VELLUM_JOB_TIMEOUT_MS` | `240000` | Per-job overall timeout (~4 min); additionally each profile has a 60s budget |

## Behavior

- **Claim**: atomic
  `UPDATE preview_jobs SET status='running', startedAt=?, attempts=attempts+1 WHERE status='queued' AND id=(oldest queued)`
  (single statement, `RETURNING *`) — safe against concurrent workers.
- **Profiles**: `job.profiles` (names from `PREVIEW_PROFILES` in
  `@vellum/core`); unknown names produce a warning diagnostic. Max 2
  concurrent pages, single reused chromium browser, fresh context/page per
  profile for isolation.
- **Widget**: when the design contains a widget presentation, the worker renders the launcher
  mirror (same tokens as the real widget, see `WidgetMirror`) at the real instance sizes
  (`widget-mirror-small` 250x140, `widget-mirror-large` 320x320) and attaches those screenshots to
  the same review, flagged with an info diagnostic `widget_preview_approximate`. No extra
  container, toolchain or emulation is required — it runs inside the existing browser.
- **Render**: injects the spec out-of-band (`page.addInitScript` → `window.__vellumSpec`)
  and navigates to `VELLUM_RENDERER_URL + '/preview.html'`. The spec is deliberately NOT
  passed in the query string: inlined assets blow past the server's HTTP header limit
  (Node default 16 KB) and the page load fails with 431 (every profile then times out).
  Uploaded images are fetched and inlined as `data:` URLs (≤1 MB each, ≤4 MB total, else an
  `asset_not_inlined` warning) so the reviewed screenshot contains the real image; the
  request sandbox allows `data:`/`blob:` and the renderer origin, and aborts everything else.
  Diagnostics also report `image_not_rendered` when an `<img>` failed to draw,
  then wait for `window.__vellumReady === true` (60s). Every request whose
  origin differs from `VELLUM_RENDERER_URL` is aborted via route interception —
  the preview is fully sandboxed and never hits real endpoints.
- **Diagnostics**:
  - console `error` messages and `pageerror`s → `{severity:'error', code:'runtime_error'}`
    (favicon 404 noise filtered);
  - per `[data-component-id]`: `scrollWidth > clientWidth + 2` →
    warning `possible_horizontal_overflow` with `componentId`;
  - interaction test: for **every** checklist component bound to a non-empty
    list dataset, the first rendered row's toggle control
    (`.vellum-checklist-row .vellum-checklist-box`) is clicked; asserts
    `window.__vellumActions` recorded `{kind:'toggleItem'}` with the itemId
    the renderer will show first (showCompleted filter + done-items-last
    stable sort, mirroring the renderer) → otherwise error
    `interaction_test_failed`.
- **Review**: `review_<hex>` id, bound to exact `draftId`/`draftVersion`/
  `contentHash` (recomputed with core's `contentHash`), `rendererVersion` /
  `catalogueVersion` from core, screenshot paths relative to the artifact
  dir, `datasetSnapshots` = `{datasetId: version}` at preview time, status
  `failed` (any error diagnostic) / `passed_with_warnings` (any warning) /
  `passed`. Job → `done` + `reviewId`, or `failed` + error text.
- **Shutdown**: on SIGTERM/SIGINT the browser is closed and an in-flight
  job is released back to `queued`.

## Expected schema (mirrors `packages/server/src/db.ts`)

- `preview_jobs(id, draftId, draftVersion, contentHash, profiles JSON, status queued|running|done|failed, createdAt, startedAt, finishedAt, reviewId, error, attempts)`
- `reviews(id, draftId, draftVersion, contentHash, rendererVersion, catalogueVersion, profiles JSON, diagnostics JSON, screenshots JSON, datasetSnapshots JSON, status passed|passed_with_warnings|failed, createdAt)`
- `drafts(id, version, content JSON, updatedAt)`
- `datasets(id, title, ownership, schema JSON, value JSON, source, updatedAt, version)`

better-sqlite3 with `journal_mode = WAL` and `busy_timeout = 5000`.
