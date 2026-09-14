# @vellum/web

Vite React client for Vellum dashboards.

## Pages

- `/` — live dashboard client.
  - Fetches `GET /api/state` (bearer from `localStorage.vellum_client_token` or `?token=`).
  - Renders the active publication via `DashboardRenderer` (target auto-selected by viewport width).
  - Submits actions via `POST /api/actions` with idempotency keys.
  - Listens to `GET /api/stream` (SSE) with reconnect/backoff; shows stale/offline banners and pending spinners.
- `/preview.html` — isolated preview sandbox.
  - Reads render spec from `?spec=<base64url-json>` or `window.name`.
  - Renders via `DashboardRenderer` with `preview={true}`.
  - Wires `onAction` to `window.__vellumActions`; sets `window.__vellumReady = true` after mount.
  - No network calls; images render as placeholder boxes.

## Dev

```bash
npm run dev   # vite dev server
npm run build # tsc --noEmit && vite build (emits dist/index.html + dist/preview.html)
```

Proxy: `/api` → `http://localhost:8787`

## Tests (manual smoke, require playwright + a running server)

- `node smoke-preview.mjs` — serves `dist/` statically and exercises `preview.html`
  (ready flag, `data-component-id`s, action recording, pagination, tabs, overrides,
  image placeholder, overflow at 360px/1280px).
- `node live-test.mjs` (env `BASE`, default `http://localhost:8801`) — live client against a
  running server: renders publication, submits a toggleItem action, verifies server-side apply.
- `node sse-test.mjs` — verifies SSE refetch: agent-side `patchItem` shows up in the client
  without user interaction.

