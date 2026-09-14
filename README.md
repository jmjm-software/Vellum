# Vellum

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
