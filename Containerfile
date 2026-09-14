# syntax=docker/dockerfile:1.7
#
# Vellum runtime image — dashboard service, preview worker, CLI, MCP stdio server.
#
# Build:  docker build -f Containerfile -t ghcr.io/<org>/vellum:local .
#         podman build -f Containerfile -t ghcr.io/<org>/vellum:local .
#
# Run (server + preview worker together):
#         docker run -p 8787:8787 -v vellum-data:/data ghcr.io/<org>/vellum:local
# Run (single service):
#         docker run -p 8787:8787 -v vellum-data:/data ghcr.io/<org>/vellum:local server
#         docker run -v vellum-data:/data ghcr.io/<org>/vellum:local worker
# MCP stdio server for a harness (stdio must stay attached, no TTY needed):
#         docker run -i -v vellum-data:/data ghcr.io/<org>/vellum:local mcp
# CLI against a running instance:
#         docker run --rm -e VELLUM_SERVER=http://host:8787 ghcr.io/<org>/vellum:local cli status
#
# Tokens: set VELLUM_CLIENT_TOKEN / VELLUM_AGENT_TOKEN in production. If unset the
# service logs a warning and uses dev-only defaults (see packages/server/src/auth.ts).

# ---------------------------------------------------------------------------
# Stage 1: build all TypeScript packages and the web client
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS build
WORKDIR /src

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/renderer/package.json packages/renderer/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
COPY packages/preview-worker/package.json packages/preview-worker/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime — production deps + playwright chromium for the preview worker
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=8787 \
    VELLUM_DATA_DIR=/data \
    VELLUM_RENDERER_URL=http://127.0.0.1:8787

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/renderer/package.json packages/renderer/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
COPY packages/preview-worker/package.json packages/preview-worker/
# Production deps only; chromium + its system libraries for the preview worker.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

# Compiled outputs (web/dist is served statically by the server and is also the
# isolated /preview.html surface the preview worker drives).
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/packages/server/dist packages/server/dist
COPY --from=build /src/packages/cli/dist packages/cli/dist
COPY --from=build /src/packages/preview-worker/dist packages/preview-worker/dist
COPY --from=build /src/packages/web/dist packages/web/dist

COPY scripts/container-entrypoint.sh /usr/local/bin/vellum-entrypoint
RUN chmod +x /usr/local/bin/vellum-entrypoint && mkdir -p /data

VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["vellum-entrypoint"]
CMD ["all"]
