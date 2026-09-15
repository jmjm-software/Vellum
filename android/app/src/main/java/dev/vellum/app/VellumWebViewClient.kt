package dev.vellum.app

import android.content.Context
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream

/**
 * Serves the shared web renderer inside the WebView.
 *
 * Online:  requests pass through natively. The client token is injected into
 *          `localStorage.vellum_client_token` (a transport the web client
 *          already supports), so the page's own fetches carry Authorization
 *          and POST bodies work without any native bridge involvement.
 * Offline: static assets are served from the disk bundle, GET /api/state from
 *          the cached payload tagged `X-Vellum-Offline: 1` (the web client
 *          shows its stale banner), all other API calls 503. Writes the page
 *          attempts while offline are queued through VellumBridge and replayed
 *          on reconnect (the server dedupes by idempotencyKey).
 *
 * No broad JavaScript bridge: exactly one method, VellumBridge.postMessage.
 */
class VellumWebViewClient(
    private val context: Context,
    private val serverUrl: String,
    private val token: String,
    private val online: () -> Boolean
) : WebViewClient() {

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        if (online()) return null
        val req = request ?: return null
        val path = req.url?.path ?: return null

        if (path.startsWith("/api/")) {
            if (req.method == "GET" && path == "/api/state") {
                val cached = ShellStore.cachedState(context)
                if (cached != null) {
                    return WebResourceResponse(
                        "application/json", "utf-8", 200, "OK",
                        mapOf(
                            "Content-Type" to "application/json",
                            "Cache-Control" to "no-store",
                            "X-Vellum-Offline" to "1"
                        ),
                        ByteArrayInputStream(cached.toByteArray())
                    )
                }
            }
            return json503()
        }

        val file = if (path == "/" || path.isEmpty()) ShellStore.cachedIndex(context) else ShellStore.cachedAsset(context, path)
        if (file != null) {
            return WebResourceResponse(
                mimeFor(path), "utf-8", 200, "OK",
                mapOf("Cache-Control" to "no-store"),
                file.inputStream()
            )
        }
        return WebResourceResponse(
            "text/plain", "utf-8", 404, "Not Found",
            emptyMap(), ByteArrayInputStream("offline".toByteArray())
        )
    }

    /**
     * Safety net: navigation the page attempts to somewhere other than the
     * configured dashboard origin opens in the system browser instead of
     * replacing the token-bearing dashboard page.
     */
    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val target = request?.url ?: return false
        val dashboardHost = runCatching { java.net.URI(serverUrl).host }.getOrNull()
        if (dashboardHost != null && target.host == dashboardHost) return false // in-dashboard navigation
        return ExternalLinks.open(view?.context ?: context, target.toString())
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        // Hand the page its transport credential (web client reads this key).
        val escaped = token.replace("\\", "\\\\").replace("'", "\\'")
        view?.evaluateJavascript("localStorage.setItem('vellum_client_token', '$escaped');") { }
        primeBundle()
    }

    /** Mirror index.html + referenced assets for future offline use. */
    private fun primeBundle() {
        if (!online()) return
        Thread {
            runCatching {
                val html = ApiClient.getString("$serverUrl/", token)
                ShellStore.cacheIndex(context, html)
                val regex = Regex("(?:src|href)=\"(/assets/[^\"]+)\"")
                for (m in regex.findAll(html)) {
                    val assetPath = m.groupValues[1]
                    if (ShellStore.cachedAsset(context, assetPath) == null) {
                        ShellStore.cacheAsset(context, assetPath, ApiClient.getBytes("$serverUrl$assetPath", token))
                    }
                }
                // Keep the offline state cache fresh even between worker runs.
                runCatching {
                    val state = ApiClient.getString("$serverUrl/api/state", token)
                    ShellStore.cacheState(context, state)
                }
            }.onFailure { Log.w(TAG, "bundle prime failed", it) }
        }.start()
    }

    private fun json503() = WebResourceResponse(
        "application/json", "utf-8", 503, "Service Unavailable",
        emptyMap(), ByteArrayInputStream("{}".toByteArray())
    )

    private fun mimeFor(path: String): String = when {
        path.endsWith(".html") -> "text/html"
        path.endsWith(".js") -> "application/javascript"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".svg") -> "image/svg+xml"
        else -> "text/plain"
    }

    companion object {
        private const val TAG = "VellumWeb"
    }
}
