# Vellum Android (implemented)

Kotlin shell + WebView hosting the **same `@vellum/renderer` build** the web app uses, plus a
Glance launcher widget rendering the agent-designed `WidgetSpec` compact presentation.

## What ships in this module (`android/app`)

| Piece | Behavior |
| --- | --- |
| `MainActivity` | WebView shell: loads the configured server, injects the client token into `localStorage.vellum_client_token` (the web client's existing transport), deep link `vellum://dashboard`, options menu (refresh/settings) |
| `VellumWebViewClient` | Online: pass-through (page fetches with its own token). Offline: serves the cached web bundle + cached `/api/state` tagged `X-Vellum-Offline: 1` (web client shows the stale banner); other APIs 503. Also a navigation safety net: any URL outside the dashboard origin opens in the system browser instead of replacing the token-bearing page |
| `Bridge` | The **only** JS surface, one method `postMessage`: `queueAction` (offline action queue, replayed on reconnect — server dedupes by idempotencyKey), `cacheState`, `ready`. No broad WebView bridge (§10). |
| `ShellStore` | Disk caches: web bundle (primed from `index.html` + hashed assets after first load), last `/api/state` payload, offline action queue |
| `NetworkMonitor` | Available/lost transitions → flush queue + `vellum:refresh` event + reload |
| `SettingsActivity` | Server URL + client token in `EncryptedSharedPreferences` (client token only — agent tokens never live on a phone), test-connection button |
| `WidgetUpdateWorker` | Periodic (15 min) + on-foreground refresh of the widget snapshot + asset prefetch |
| `VellumWidget` | Native Glance renderer for `WidgetSpec`: text (title/caption/body), metric, list (filter `unchecked`, `maxItems`, remaining count), progress (block bar), image (cached asset), action buttons. **Flexible sizing**: item budget adapts to `LocalSize` (launchers disagree about cell sizes). **Live**: while the app is in use, every state refresh the web client performs is reported over the bridge and the widget re-renders immediately (`WidgetRenderWorker`, no network). **Starter fallback**: when the published design carries no `WidgetSpec`, the widget synthesizes a conservative presentation from the first list/metric dataset (title + list with remaining count, or metric) + open-dashboard action — so the launcher widget is useful on any dashboard until an agent designs one. |
| `PerformToggle`/`PerformEvent` | Widget actions → the same `/api/actions` endpoint as the web client (dashboard-owned = apply locally; mirrored = harness event). Never a model call. |
| `ExternalLinks` | Opens `link` components and `openUrl` actions (from the dashboard or the widget) in the platform browser. Re-validates http(s)-only, no credentials, no `javascript:`/`data:`/`file:`/`intent:` schemes — agent-authored links are untrusted input (§10). |

The server needs **no changes** to support this: `/api/state` already carries the publication
(including `widget`) + datasets, and `/api/assets/:id` serves images.

## Build

```bash
# one-time toolchain (any Linux/macOS):
#   - JDK 17, Android SDK (compileSdk 35, build-tools 35), Gradle 8.10.2
#   - pointed to by android/local.properties (sdk.dir=...)

cd android
./gradlew assembleDebug        # apk: app/build/outputs/apk/debug/app-debug.apk
./gradlew lintDebug            # static analysis
```

## Versioning policy (important for installs)

**Every change under `android/` bumps `versionCode`** (and `versionName` for humans). Android only
installs an APK over an existing app when `versionCode` increases — with an unchanged code the
install fails and the old app has to be uninstalled first. Current: `versionCode 5` / `0.1.4`.

Server/web-only changes need **no** APK update: the dashboard UI is the web client served by the
service (the WebView loads it on every launch), so pulling the new container is enough. Only
native shell/widget changes require a new APK.

## CI (`android-apk` workflow)

`.github/workflows/android.yml` builds the APK on GitHub Actions whenever `android/**`
changes on `main` or in a PR, or on `workflow_dispatch`:

- JDK 17 (temurin) + real Android SDK (`platforms;android-35`, `build-tools;35.0.0`)
  via `android-actions/setup-android`; wrapper-pinned Gradle 8.10.2 with the Gradle cache
- runs `:app:assembleDebug` + `:app:lintDebug`
- uploads `vellum-apk-debug` (installable, debug-signed) and the lint report as artifacts
  (14-day retention)
- on tag push (`v*`): attaches the APK to the GitHub Release via `softprops/action-gh-release`

The wrapper lives in the repo (`android/gradlew` + `android/gradle/wrapper`), so no
Gradle install is needed on a fresh checkout.

Release signing is deliberately out of scope for now: the pipeline emits the
installable debug APK; a signed `assembleRelease` (with your own keystore as a
GitHub secret) can be added when you intend to distribute outside sideloading.

## Manual test on a device/emulator

1. Run a vellum server: `bash scripts/stack-up.sh /tmp/vellum-dev`
2. Publish a design with a shopping list (see `scripts/e2e.mjs` for the payloads)
3. `adb install android/app/build/outputs/apk/debug/app-debug.apk`
4. First launch → Settings → server URL (`http://<host-ip>:8787`) + client token (`client-dev-token`)
5. Verify: dashboard renders; kill the server → app still shows the last state with the
   offline banner; toggle an item offline → comes back after reconnect; long-press → add
   the Vellum widget → it renders the agent's widget design (title/count/items).

## Widget review: what is covered where

The publish pipeline's screenshot review covers the **dashboard targets only** (`phone-small`,
`phone-large`, `desktop`) — a browser screenshot cannot validate a native widget (architecture
§4/§7), so the widget is deliberately *not* faked into that review. What covers the widget today:

| Layer | What it does | Runs where |
| --- | --- | --- |
| Design validation (server) | Widget-spec sanity warnings: component count, single-line text length, list `maxItems`, unknown assets, unknown datasets | every `dashboard_edit` |
| Native widget tests | Renders the real Glance widget and asserts the node tree: designed components render, `filter: unchecked` hides done items, `maxItems` truncates, remaining count appears, the cached image renders (or a visible placeholder), starter fallback works | `./gradlew :app:testDebugUnitTest` and the `android-apk` CI job |
| Native widget renderer | Renders the real Glance widget (its RemoteViews) to PNGs at launcher sizes and attaches them to the **review record**, so `dashboard_preview` returns them to the agent as image blocks and a failed render **blocks publication** | `scripts/render-widget-previews.sh` via `VELLUM_WIDGET_RENDERER_CMD`; previews also land in `android/app/build/widget-previews` (CI artifact `vellum-widget-previews`) |

### Enabling the native widget review

```bash
# Renderer (needs JDK 17 + Android SDK; same toolchain as building the APK):
export VELLUM_WIDGET_RENDERER_CMD="$PWD/scripts/render-widget-previews.sh"
bash scripts/stack-up.sh        # preview worker picks it up
```

- The worker writes the same state shape the widget consumes (`publication.content.widget` +
  `datasets` + inlined asset bytes) to `widget-spec.json`, runs the command, and collects the
  `widget-*.png` files it produces into `<data>/artifacts/reviews/<reviewId>/widget/`.
- `dashboard_context.capabilities.widget` reflects whether a renderer is attached, so the agent
  knows before publishing whether the widget will actually be reviewed.
- Without a renderer the review records an explicit `widget_preview_unavailable` **warning**
  (publish still allowed) instead of silently skipping the widget.
- Renderer output is real RemoteViews pixels (Robolectric native graphics). It is *not* a browser
  approximation; fidelity is high but the launcher's own chrome (padding, corner masks, dynamic
  colors) is not part of the image.
- The default container image has no JDK/Android SDK, so a self-hosted deployment either runs the
  renderer where that toolchain exists or uses the CI artifacts.

## Known limitations (documented, not hidden)

- **Widget preview is device-only.** The architecture's rule — widget preview must exercise the
  native implementation, never a browser screenshot — is honored by NOT offering a browser
  preview for widgets. There is no `widget` entry in the preview-worker profiles; the native unit
  tests above cover structure, not pixels.
- Cleartext HTTP is permitted (`usesCleartextTraffic=true`) for self-hosted LAN servers; use
  HTTPS in production.
- Image components in the widget render only from the prefetched cache (no lazy network load
  in background updates).
- Widget update cadence is WorkManager periodic (15 min) + foreground refresh; push-level
  freshness is a harness/host concern (§9 continuous mode).
- `app-debug.apk` is a debug build; the release build has minification disabled for now.

## Milestone status (architecture §11)

- [x] Minimal product slice (checklist + metric, drafts, previews, guarded publish)
- [x] Shared renderer validated in a real harness (hermes)
- [x] **Android shell** (this module)
- [x] **One native launcher-widget presentation** (shopping-list widget, this module)
- [ ] Catalogue expansion, more widget presentations, richer CLI TUI