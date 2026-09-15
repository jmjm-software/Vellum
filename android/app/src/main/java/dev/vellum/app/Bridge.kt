package dev.vellum.app

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * The *only* JavaScript-exposed surface (architecture §10: avoid broad native
 * bridges). Messages:
 *   { "type": "queueAction", "body": <action request json> }  — page could not
 *       reach the server; enqueue locally, replay on reconnect.
 *   { "type": "cacheState", "json": <state json> }            — keep the
 *       offline snapshot fresh from the page's own successful fetches.
 *   { "type": "openUrl", "href": <http(s) url> }              — open an external
 *       page in the platform browser (dashboard content never navigates itself).
 *   { "type": "ready" }                                       — page mounted.
 */
class Bridge(private val host: Host) {
    interface Host {
        fun onQueuedAction(idempotencyKey: String, body: String)
        fun onCacheState(json: String)
        fun onOpenUrl(href: String)
        fun onPageReady()
    }

    @JavascriptInterface
    fun postMessage(messageJson: String) {
        runCatching {
            val msg = JSONObject(messageJson)
            when (msg.optString("type")) {
                "queueAction" -> {
                    val body = msg.optJSONObject("body")?.toString() ?: return
                    val key = msg.optJSONObject("body")?.optString("idempotencyKey")
                        ?: return
                    host.onQueuedAction(key, body)
                }
                "cacheState" -> msg.optString("json").takeIf { it.isNotBlank() }?.let { host.onCacheState(it) }
                "openUrl" -> msg.optString("href").takeIf { it.isNotBlank() }?.let { host.onOpenUrl(it) }
                "ready" -> host.onPageReady()
            }
        }
    }
}
