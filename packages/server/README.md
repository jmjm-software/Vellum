# @vellum/server

Persistent Vellum service: SQLite storage, application functions (`AppService`),
client HTTP API + SSE, agent HTTP API, MCP stdio server, and the preview job queue.
MCP handlers and HTTP handlers call the **same** `AppService` — no internal HTTP hop.

## Entry points

| Entry point | Command | Purpose |
| --- | --- | --- |
| `src/index.ts` | `npm start` / `node dist/index.js` | Express HTTP server (client API, agent API, SSE, static web client) |
| `src/mcp-stdio.ts` | `npm run mcp` / `node dist/mcp-stdio.js` | MCP stdio server exposing exactly the six `MCP_TOOL_NAMES` tools |

Supporting modules: `src/app.ts` (`AppService` — all application functions),
`src/db.ts` (better-sqlite3 schema + WAL, artifact dir), `src/auth.ts` (bearer
token middleware), `src/sse.ts` (SSE broadcast manager).

Build: `npx tsc -p tsconfig.json` (outputs to `dist/`).

### HTTP server (`src/index.ts`)

Client routes (bearer `VELLUM_CLIENT_TOKEN`; assets/screenshots also accept the agent token):

- `GET /api/health` — public liveness + renderer/catalogue versions
- `GET /api/state` — full client state (publication + datasets)
- `GET /api/publication` — current publication
- `GET /api/datasets/:id` — one dataset
- `GET /api/history`, `GET /api/history/:revision` — publication history
- `POST /api/actions` — client action (`{ type, datasetId, itemId?, payload?, idempotencyKey }`)
- `GET /api/assets/:id` — asset bytes
- `GET /api/reviews/:reviewId/screenshots/:profile` — png screenshot (path-traversal protected)
- `GET /api/stream` — SSE (`publication`, `dataset`, `action` events)

Agent routes (bearer `VELLUM_AGENT_TOKEN`, all POST, bodies per `@vellum/core/protocol`):

- `/api/agent/context`, `/api/agent/edit`, `/api/agent/preview` (also accepts `{ jobId }`
  to poll a job), `/api/agent/publish`, `/api/agent/data`, `/api/agent/events`,
  `/api/agent/rollback` (`{ revision, idempotencyKey? }` — republishes historic content,
  never touches data)

If `packages/web/dist` exists it is served statically at `/` with an SPA fallback.

### MCP stdio server (`src/mcp-stdio.ts`)

Tools (exactly six, from `@vellum/core/protocol`): `dashboard_context`, `dashboard_edit`,
`dashboard_preview`, `dashboard_publish`, `dashboard_data`, `dashboard_events`.
Server `instructions` = `AUTHORING_GUIDANCE`; tool descriptions state the next required
step (edit → preview → review → publish). `dashboard_preview` with `{ jobId }` returns
that job's result; otherwise it enqueues a job and returns a handle. When a review
exists, the result includes png image content blocks (base64 from the review's
artifact files) plus structured JSON (diagnostics, reviewId, status, nextStep).

Stdio MCP is spawned locally by the agent harness (trusted local process); the
agent token applies to the HTTP agent routes.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP listen port (`src/index.ts`) |
| `VELLUM_DATA_DIR` | `./.vellum-data` (repo root) | SQLite `store.db` + `artifacts/` directory (shared with the preview worker; WAL enabled) |
| `VELLUM_CLIENT_TOKEN` | `client-dev-token` | Bearer token for client read/action routes (warning logged on default) |
| `VELLUM_AGENT_TOKEN` | `agent-dev-token` | Bearer token for agent routes + MCP (warning logged on default) |

Example:

```sh
VELLUM_DATA_DIR=/tmp/vellum node dist/index.js          # HTTP API on :8787
VELLUM_DATA_DIR=/tmp/vellum node dist/mcp-stdio.js      # MCP over stdio
```
