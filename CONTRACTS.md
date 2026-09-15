# Vellum — implementation contracts (read before coding)

Vellum is an **agent-designed dashboard service** (see `architecture.md`). One persistent
service, one MCP connection, agent-authored component layouts, shared web/Android renderer,
separate data updates, guarded preview-to-publish workflow.

## Monorepo layout

| Package | Responsibility | Status owner |
| --- | --- | --- |
| `packages/core` | Domain types, component catalogue, validation, patch ops, wire protocol, hashing. **DONE — do not modify.** | — |
| `packages/server` | SQLite persistence, application functions, MCP server (stdio + streamable HTTP), client HTTP API + SSE, auth, preview job queue. | worker:server |
| `packages/renderer` | React renderer for `DesignContent` + datasets (production renderer used by web AND previews). | worker:renderer |
| `packages/web` | Vite React app: live dashboard client (reads state, submits actions, SSE updates) + `/preview.html` isolated render page for the preview worker. | worker:renderer |
| `packages/cli` | Terminal client: status, data inspection, events, history, rollback. | worker:cli |
| `packages/preview-worker` | Playwright worker: polls job queue, renders drafts via the web app's preview page, screenshots per profile, runs diagnostics + interaction checks, writes review artifacts. | worker:preview |

## Non-negotiables

1. **`@vellum/core` is the contract.** Import types from it; never redefine them. It is already
   built (`packages/core/dist`). Do NOT edit anything in `packages/core`.
2. Stay inside your own package directory. Do not run `npm install` (deps are preinstalled at
   the workspace root). You may only add files under your package.
3. TypeScript must compile clean: `cd packages/<yours> && npx tsc -p tsconfig.json` (renderer/web
   use `--noEmit`).
4. ESM only (`"type": "module"`). Node 22. Relative imports in server/cli/preview-worker need
   `.js` extensions (NodeNext resolution).
5. MCP handlers and HTTP handlers call the **same application functions** — no internal HTTP hop.
6. All agent-authored content and dataset values are untrusted: validate with core's
   `validateDesign` / `validateDatasetValue` before storing/rendering. Text is rendered as text
   (React escapes by default) — never `dangerouslySetInnerHTML`.

## Server application surface (used by MCP + HTTP)

Implement in `packages/server/src/app.ts` an `AppService` class (or equivalent) with these
functions (names/types per `@vellum/core/protocol`):

- `getContext(args: ContextArgs): ContextResult`
- `edit(args: EditArgs): EditResult` — draft create/patch; increments `draft.version`; runs
  `validateDesign`; returns diagnostics + `nextStep` hint ("preview this draft version").
- `requestPreview(args: PreviewArgs): PreviewResult` — enqueues a `PreviewJob` row; if job for the
  exact (draftId, draftVersion, contentHash) already finished, returns its review. Blocks when
  `draftVersion` != current draft version (`precondition_failed`).
- `getPreviewJob(jobId): PreviewResult` — same tool retrieves results (§10 job handle).
- `publish(args: PublishArgs): PublishResult` — transaction enforcing: review exists, review
  matches current draft version + contentHash, review status != failed, no blocking diagnostics,
  `expectedPublishedRevision` matches current publication (optimistic concurrency), idempotencyKey
  dedupe. New datasets introduced by the draft become visible atomically with the pointer swap;
  live datasets are NEVER overwritten by preview snapshots. Rollback = publish an older design
  content as a new revision (never rolls back data).
- `data(args: DataArgs): DataResult` — dataset CRUD/patchItem with schema+size validation and
  per-dataset optimistic `version`. `patchItem` on a **dashboard-owned** list applies directly
  (no model call). On a **mirrored** dataset it creates a pending harness event instead.
- `events(args: EventsArgs): EventsResult` — list/claim/ack/submit with dedupe on
  `(idempotencyKey)` and `(datasetId,itemId,type)` while pending. Ack with `patch` reconciles the
  displayed state.
- `clientAction(req: SubmitActionRequest): SubmitActionResult` — client-side action entry.
- `getPublicState(): DashboardState`, `getPublication()`, `getDataset(id)`.
- History: `listRevisions()`, `getRevision(n)`.

Persistence: better-sqlite3, file at `$VELLUM_DATA_DIR/store.db` (default `./.vellum-data`).
Tables (suggested): drafts, publications, revisions(history), datasets, actions, reviews,
preview_jobs, assets, idempotency, meta. Artifacts (screenshots) under `$VELLUM_DATA_DIR/artifacts`.

Auth: bearer tokens from env — `VELLUM_CLIENT_TOKEN` (read/action) and `VELLUM_AGENT_TOKEN`
(edit/publish/data/events agent routes + MCP). If unset, default dev tokens `client-dev-token` /
`agent-dev-token` are used and a warning is logged. Screenshots/assets require client-or-agent token.

Entry points:
- `src/index.ts` — HTTP server (express) on `$PORT` (default 8787): client API per
  `HTTP_ROUTES`, agent HTTP routes (same app functions), SSE stream (`publication`, `dataset`,
  `action` events), serves `packages/web/dist` statically at `/` if present.
- `src/mcp-stdio.ts` — MCP stdio server exposing exactly the `MCP_TOOL_NAMES` (seven: context/edit/preview/publish/data/asset/events) with
  `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), zod input schemas, and
  `dashboard_preview` returning image content blocks (base64 png) alongside structured JSON.
- `src/mcp-http.ts` (optional stretch) — streamable HTTP transport mount.

MCP server `instructions` field = `AUTHORING_GUIDANCE` from core. Tool descriptions must state
the next required step (preview → review → publish).

## Renderer contract

`packages/renderer/src/index.ts` exports:

- `DashboardRenderer({ content, datasets, target, onAction, width? })` — React component that
  renders a `DesignContent` tree bound to `Dataset[]` for a `TargetKind` ("phone"|"desktop").
  Applies per-target overrides (span/order/hidden/compact), grid layout (12-col default),
  overflow policies (showMore/scroll/paginate implemented client-side), empty states.
- `collectDiagnostics(content, datasets): Diagnostic[]` — measurement-independent structural
  checks reusable by the preview worker (unknown bindings, empty containers, etc.). Use core's
  `validateDesign` as the base and add data-fit warnings (e.g. 30 items with maxVisible 6 is
  fine; a 500-char label is a warning).
- Components: grid, stack, section, card, tabs, checklist, metric, chart (pure SVG line/bar — no
  chart lib), table, text, image (asset via `/api/assets/:id`), button.
- `onAction(action: ActionSpec, ctx: { componentId: string })` callback for interactions;
  checklist row clicks = `toggleItem`.
- Deterministic rendering: no animations/random; stable DOM `data-component-id` attributes on
  every component root (preview worker queries these).
- Plain CSS file(s) imported by the renderer (`styles.css`), dark-neutral clean look, system
  font stack. Must render correctly at 360px..1280px+.

## Web app contract

Vite + React. Two pages:
- `/` — live client: fetches `GET /api/state` (bearer client token from
  `localStorage.vellum_client_token` or `?token=`), renders publication via `DashboardRenderer`,
  submits actions `POST /api/actions`, subscribes `GET /api/stream` (SSE, refetch-on-event with
  reconnect/backoff), shows "stale/offline" state and pending-action spinners (§9: never imply an
  external service updated before confirmation).
- `/preview.html` (+ `src/preview.tsx`) — isolated preview page used by the preview worker:
  reads a render spec from `window.name` or `?spec=<base64url json>` containing
  `{ content, datasets, target, profile }`, renders via `DashboardRenderer`, wires `onAction` to
  a sandbox recorder exposed as `window.__vellumActions` (array), and sets
  `window.__vellumReady = true` when mounted. NO network calls in preview mode (pass datasets
  inline; images render a placeholder box when assets unavailable).

Dev proxy in `vite.config.ts`: `/api` -> `http://localhost:8787`. Build output `dist/`.
`npm run build` must pass (tsc --noEmit + vite build).

## Preview worker contract

`packages/preview-worker/src/index.ts`:
- Polls server job queue via an internal endpoint **or** direct sqlite access — choose direct
  sqlite claim (`UPDATE ... WHERE status='queued'` guarded) using the same db path env
  `VELLUM_DATA_DIR`; simplest and avoids an HTTP hop. Mark `running` with `startedAt`.
- For each profile in the job (default all `PREVIEW_PROFILES`): launch chromium (playwright),
  viewport per profile, `page.goto(rendererUrl + '/preview.html?spec=...')`, wait for
  `window.__vellumReady`, screenshot (png) to `<artifactDir>/reviews/<reviewId>/<profile>.png`.
- Diagnostics (evidence, not ceremony §7): runtime console errors => error diagnostic; overflow
  checks per `data-component-id` (scrollWidth > clientWidth + tolerance => warning "possible
  horizontal overflow"); interaction test: for checklist components click the first row checkbox
  and assert `window.__vellumActions` received a `toggleItem` with the right itemId (sandboxed —
  never hits real data).
- Writes review record JSON to db (reviews table) with screenshots, diagnostics, status
  (`failed` if any error-severity diagnostic), dataset snapshots (datasetId -> version),
  renderer/catalogue versions, contentHash, draftId+version. Marks job `done` + `reviewId`.
- Limits: job timeout 60s/profile, max 2 concurrent pages, catch all failures -> job `failed`
  with error message. `rendererUrl` from env `VELLUM_RENDERER_URL` (default
  `http://localhost:8788` — web dev server or server-static dist).

DB sharing note: worker and server both use better-sqlite3 with WAL mode enabled by the server.

## CLI contract

`vellum` commands (talk to HTTP API, `--server` / `$VELLUM_SERVER` default
`http://localhost:8787`, `--token` / `$VELLUM_CLIENT_TOKEN`):
- `status` — publication revision, publishedAt, datasets summary, pending event counts.
- `design` — pretty-print published design tree (indented, component ids/types/spans).
- `data list` / `data get <id>` — dataset inspection (tables/lists in terminal).
- `events [--status s]` — event inspection; `events ack <id> <success|failed>`.
- `history` — revision list; `rollback <revision>` — POST an agent-privileged rollback (uses
  agent token `$VELLUM_AGENT_TOKEN`; server exposes `POST /api/agent/rollback {revision}` which
  republishes historic content as a new revision WITHOUT touching data).
- `watch` — SSE stream printing updates.
Compact terminal presentations only — no full TUI (§4 "keep the CLI honest").

## Definition of done (per worker)

- `npx tsc -p tsconfig.json` clean in your package (renderer/web: `--noEmit`; web also
  `npx vite build` succeeds).
- Code follows the contracts above; security rules respected.
- A short `packages/<yours>/README.md` documenting entry points and env vars.
