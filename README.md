# Vellum

> [!WARNING]
> **Work in progress — experimental project.**
> Vellum is a personal research experiment in agent-designed dashboards, built to test
> whether an AI agent can responsibly own the presentation layer of a persistent personal
> dashboard. It is **not production-ready**: expect breaking changes, incomplete docs and
> rough edges. Do not deploy it with real credentials or sensitive data.
> See [Status](#status) for what works today.

An **agent-designed dashboard service**: one persistent service, one MCP connection, an
agent-authored component layout, a shared web/Android renderer, data updates independent of
design changes, and a guarded preview-to-publish workflow.

See `architecture.md` for the full design rationale and `CONTRACTS.md` for implementation
contracts.

## Packages

| Package | Purpose |
| --- | --- |
| `packages/core` | Domain types, component catalogue, validation, patch ops, wire protocol |
| `packages/server` | SQLite persistence, app functions, MCP server (stdio), HTTP API + SSE, auth, preview job queue |
| `packages/renderer` | Shared React renderer for design documents + datasets |
| `packages/web` | Browser client + isolated `/preview.html` render surface |
| `packages/cli` | Terminal client: status, data, events, history, rollback |
| `packages/preview-worker` | Playwright worker: screenshots, diagnostics, interaction tests |

Android (Kotlin WebView shell + Glance widgets) is a later milestone — see `android/README.md`.

## Status

Work in progress. Implemented and covered by the e2e acceptance suite today:

- Component catalogue + validated agent-authored design documents (drafts, reviews, publications)
- Guarded preview-to-publish loop with Playwright screenshots and diagnostics
- MCP stdio server (six tools), HTTP client API + SSE, token-separated auth
- Shared React renderer (web + isolated preview surface), CLI, container image + CI

Not started / planned (see `android/README.md` and `architecture.md`):

- Android WebView shell and Glance launcher widgets (native widget preview path)
- PostgreSQL backend (trigger: multi-replica or managed storage; see Database topology)
- MCP Apps support, richer chart catalogue, full terminal TUI
- Harness compatibility matrix (interactive vs continuous mode)

## Quick start

```bash
npm install
npm run build                 # builds core, server, cli, preview-worker; typechecks renderer; builds web
npx playwright install chromium

# start the service (default port 8787, data in ./.vellum-data)
npm start -w @vellum/server

# serve the web client (dev) on 8788 with /api proxied to 8787
npm run dev -w @vellum/web

# start the preview worker
npm start -w @vellum/preview-worker

# connect an MCP harness (stdio):
node packages/server/dist/mcp-stdio.js
```

Environment variables:

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `VELLUM_DATA_DIR` | `./.vellum-data` | SQLite db + artifacts directory |
| `VELLUM_CLIENT_TOKEN` | `client-dev-token` | Client read/action bearer token |
| `VELLUM_AGENT_TOKEN` | `agent-dev-token` | Agent edit/publish bearer token |
| `VELLUM_RENDERER_URL` | `http://localhost:8788` | Renderer URL used by the preview worker |

## CLI

```bash
node packages/cli/dist/index.js status
node packages/cli/dist/index.js design
node packages/cli/dist/index.js data list
node packages/cli/dist/index.js events
node packages/cli/dist/index.js history
```

## Container

One image serves every surface; the entrypoint selects the mode:

```bash
docker build -f Containerfile -t ghcr.io/<org>/vellum:local .   # or podman build

docker run -p 8787:8787 -v vellum-data:/data ghcr.io/<org>/vellum:local            # server + preview worker
docker run -p 8787:8787 -v vellum-data:/data ghcr.io/<org>/vellum:local server     # HTTP server only
docker run -v vellum-data:/data ghcr.io/<org>/vellum:local worker                  # preview worker only
docker run -i -v vellum-data:/data ghcr.io/<org>/vellum:local mcp                  # MCP stdio server for a harness
docker run --rm -e VELLUM_SERVER=http://<host>:8787 ghcr.io/<org>/vellum:local cli status
```

- Port `8787` is exposed (client API, agent API, SSE, static web client, `/preview.html`).
- State lives in the `/data` volume (`VELLUM_DATA_DIR`); screenshots under `/data/artifacts`.
- The image bundles chromium for the preview worker, so previews run inside the container
  against its own server (`VELLUM_RENDERER_URL=http://127.0.0.1:8787` by default).
- Set `VELLUM_CLIENT_TOKEN` / `VELLUM_AGENT_TOKEN` in production; unset means dev defaults
  plus a startup warning.
- A healthcheck probes `/api/health`.

### One service per container

`compose.yaml` runs the split topology: a `server` container and a `worker`
container sharing one `vellum-data` volume.

```bash
docker compose up --build -d
```

### Database topology

There is no database server. SQLite is embedded: the state is a single file
(`/data/store.db`, WAL mode) plus `/data/artifacts` for screenshots, opened
in-process by the server and the preview worker. Consequences:

- Backups = copy the volume (or `sqlite3 /data/store.db ".backup ..."` while stopped).
- Single-writer, single-host: never scale replicas, never put `/data` on a network
  filesystem. Multi-replica or managed-storage deployments are the trigger to move
  to PostgreSQL (architecture.md §10); the app functions are storage-agnostic.
- The default container command `all` (server + worker in one container) is a
  single-box convenience; use `compose.yaml` or explicit `server` / `worker`
  commands when you want process isolation.

## CI

`.github/workflows/container.yml` runs the e2e + MCP acceptance suites on every push/PR,
then builds **multi-arch images** (`linux/amd64` + `linux/arm64`) on native runners
(no QEMU): each architecture pushes by digest, a merge job combines them into one
manifest list on `ghcr.io/<owner>/vellum` (`latest`, branch, semver, and `sha-*` tags),
and the pushed image is smoke-tested by running the acceptance suite against a
container on **both** architectures (the arm64 leg exercises chromium and
better-sqlite3 natively).

## The acceptance loop (architecture §11)

`scripts/e2e.mjs` exercises: context → draft edit → preview job → publish guard (stale review
rejection) → dataset update without redesign → mirrored-dataset event flow → rollback of design
without touching data.

```bash
npm run build && node scripts/e2e.mjs
```

## Security notes

- Agent-authored documents and imported data are untrusted: everything is schema-validated
  server-side; text renders as text; no arbitrary URLs, no executable expressions.
- Client read/action permissions are separate from agent edit/publish permissions.
- Preview interactions are sandboxed and never trigger real external actions.
- Screenshots are access-controlled artifacts.
