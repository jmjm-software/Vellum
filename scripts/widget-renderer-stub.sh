#!/usr/bin/env bash
# Test double for the native widget renderer: writes placeholder PNGs so the
# review pipeline can be exercised without an Android toolchain in CI.
# Usage: widget-renderer-stub.sh <spec.json> <outDir>   (VELLUM_STUB_FAIL=1 -> fail)
set -euo pipefail
SPEC="$1"; OUT="$2"; mkdir -p "$OUT"
if [ "${VELLUM_STUB_FAIL:-0}" = "1" ]; then echo "stub renderer: deliberate failure" >&2; exit 3; fi
PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
printf '%s' "$PNG" | base64 -d > "$OUT/widget-small.png"
printf '%s' "$PNG" | base64 -d > "$OUT/widget-large.png"
echo "stub widget previews written to $OUT"
