package dev.vellum.app

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.ViewGroup
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.vellum.app.Prefs.isConfigured
import dev.vellum.app.Prefs.serverUrl
import dev.vellum.app.Prefs.clientToken
import dev.vellum.app.widget.WidgetUpdateWorker
import org.json.JSONObject

/**
 * Native shell: account setup, WebView hosting the shared renderer, offline
 * cache, deep links, lifecycle. The dashboard itself is the same React build
 * the browser uses (architecture §4).
 */
class MainActivity : AppCompatActivity(), Bridge.Host {

    private lateinit var webView: WebView
    private lateinit var monitor: NetworkMonitor
    private var configured = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!isConfigured()) {
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }
        configured = true

        webView = WebView(this)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.mediaPlaybackRequiresUserGesture = true

        monitor = NetworkMonitor(this) { online ->
            runOnUiThread {
                if (online) flushQueueAndRefresh()
                webView.reload()
            }
        }

        webView.webViewClient = VellumWebViewClient(this, serverUrl, clientToken) { monitor.online }
        webView.addJavascriptInterface(Bridge(this), "VellumBridge")

        WidgetUpdateWorker.schedule(this)
        WidgetUpdateWorker.runOnce(this)

        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                // Refresh the cached snapshot whenever the app foregrounds.
                WidgetUpdateWorker.runOnce(this@MainActivity)
            }
        })

        webView.loadUrl(serverUrl + "/")
    }

    override fun onStart() {
        super.onStart()
        if (::monitor.isInitialized) monitor.start()
    }

    override fun onStop() {
        super.onStop()
        if (::monitor.isInitialized) monitor.stop()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("VellumBridge")
            // Detach before destroy — destroying an attached WebView can itself
            // throw. The not-configured path never creates webView, so guard.
            val parent = webView.parent
            if (parent is ViewGroup) parent.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    // --- options menu ---------------------------------------------------------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_REFRESH, 0, getString(R.string.menu_refresh))
        menu.add(0, MENU_SETTINGS, 1, getString(R.string.menu_settings))
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        MENU_REFRESH -> {
            WidgetUpdateWorker.runOnce(this)
            webView.reload()
            true
        }
        MENU_SETTINGS -> {
            startActivity(Intent(this, SettingsActivity::class.java))
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    // --- Bridge.Host ------------------------------------------------------------

    override fun onQueuedAction(idempotencyKey: String, body: String) {
        ShellStore.enqueueAction(this, idempotencyKey, body)
    }

    override fun onCacheState(json: String) {
        ShellStore.cacheState(this, json)
    }

    override fun onPageReady() {
        // nothing yet; hook for future native chrome
    }

    /** Replay offline actions (server dedupes by idempotencyKey), then refresh. */
    private fun flushQueueAndRefresh() {
        val pending = ShellStore.readQueue(this)
        if (pending.isEmpty()) return
        Thread {
            for (queued in pending) {
                val ok = runCatching { ApiClient.postAction(serverUrl, clientToken, queued.body) }.isSuccess
                if (ok) ShellStore.dropQueued(this, queued.idempotencyKey) else break
            }
            runOnUiThread {
                webView.evaluateJavascript("window.dispatchEvent(new Event('vellum:refresh'));") { }
            }
        }.start()
    }

    companion object {
        private const val MENU_REFRESH = 1
        private const val MENU_SETTINGS = 2

        /** Used by widget actions to open the dashboard. */
        fun intentJson(action: JSONObject): String = action.toString()
    }
}
