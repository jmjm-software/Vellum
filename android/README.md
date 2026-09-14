# Android (future milestone)

Per `architecture.md` §4 and §11, the Android surface is deliberately **not** part of the first
complete loop. When built, it will be:

1. **Kotlin shell + WebView** hosting the exact same `@vellum/renderer` build served by the
   dashboard service (or bundled asset), with:
   - account setup and token storage (client token only),
   - local caching of the last publication for offline use (stale indicator),
   - deep links, lifecycle handling,
   - **no broad JavaScript bridge** — a minimal, message-passing-only interface for actions
     (architecture §10 security).
2. **Glance launcher widget**: a small trusted native renderer for the `WidgetSpec` compact
   presentation (text, metric, list, progress, image, approved actions) already modeled in
   `@vellum/core`. Widget previews must exercise the native implementation, not a browser
   screenshot. Flexible sizing per Android launcher-cell variance guidance.

The server already models `widget` in `DesignContent` and the `widget` target kind, so the
design/publish pipeline does not change when this lands.
