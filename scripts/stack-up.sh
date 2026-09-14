#!/usr/bin/env bash
# Start the vellum stack (server + preview worker) detached, with a fresh data dir.
set -u
cd "$(dirname "$0")/.."
DATA_DIR="${1:-/tmp/vellum-e2e}"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
fuser -k 8787/tcp 2>/dev/null
fuser -k 8788/tcp 2>/dev/null
sleep 1
setsid env VELLUM_DATA_DIR="$DATA_DIR" node packages/server/dist/index.js > "$DATA_DIR/server.log" 2>&1 < /dev/null &
sleep 2
setsid env VELLUM_DATA_DIR="$DATA_DIR" VELLUM_RENDERER_URL=http://localhost:8787 node packages/preview-worker/dist/index.js > "$DATA_DIR/worker.log" 2>&1 < /dev/null &
sleep 2
curl -sf localhost:8787/api/health && echo " — stack up (data: $DATA_DIR)"
