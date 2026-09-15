#!/usr/bin/env bash
# Native launcher-widget preview renderer.
#
# Renders the REAL Glance widget (the composables the launcher hosts, through
# their RemoteViews) to PNGs — architecture §4: a widget preview must exercise
# the native implementation, never a browser stand-in.
#
# Usage: scripts/render-widget-previews.sh <spec.json> <outDir>
#
# spec.json: the client-facing state shape the widget consumes —
#   { serverTime, publication.content.widget, datasets, assets: { assetId: base64 } }
# Writes <outDir>/widget-small.png and <outDir>/widget-large.png
#
# Requirements: JDK 17 + Android SDK (platforms;android-35, build-tools 35) +
# android/local.properties (sdk.dir). The server's preview worker calls this via
# VELLUM_WIDGET_RENDERER_CMD.
set -euo pipefail

SPEC="${1:?usage: render-widget-previews.sh <spec.json> <outDir>}"
OUT="${2:?usage: render-widget-previews.sh <spec.json> <outDir>}"
SPEC="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/android"

./gradlew --no-daemon --console=plain \
  :app:testDebugUnitTest --tests "*WidgetPreviewRendererTest*" \
  -Dvellum.widgetSpec="$SPEC" -Dvellum.outDir="$OUT"

for f in widget-small.png widget-large.png; do
  [ -s "$OUT/$f" ] || { echo "widget renderer produced no $f" >&2; exit 1; }
done
echo "widget previews: $OUT/widget-small.png $OUT/widget-large.png"
