#!/bin/sh
# Vellum container entrypoint.
#   all    (default) preview worker in background + HTTP server in foreground
#   server HTTP server only (client API, agent API, MCP-over-HTTP routes, static web)
#   worker preview worker only (polls the shared SQLite job queue)
#   mcp    MCP stdio server (for harnesses that spawn the server as a child process)
#   cli    vellum CLI; pass subcommands after, e.g. `cli status`
#   sh     debug shell
set -eu

cmd="${1:-all}"
case "$cmd" in
  server)
    exec node /app/packages/server/dist/index.js
    ;;
  worker)
    exec node /app/packages/preview-worker/dist/index.js
    ;;
  mcp)
    exec node /app/packages/server/dist/mcp-stdio.js
    ;;
  cli)
    shift
    exec node /app/packages/cli/dist/index.js "$@"
    ;;
  all)
    node /app/packages/preview-worker/dist/index.js &
    worker_pid=$!
    node /app/packages/server/dist/index.js &
    server_pid=$!
    trap 'kill "$worker_pid" "$server_pid" 2>/dev/null || true' TERM INT
    wait "$server_pid"
    ;;
  sh|shell)
    exec /bin/sh
    ;;
  *)
    exec "$@"
    ;;
esac
