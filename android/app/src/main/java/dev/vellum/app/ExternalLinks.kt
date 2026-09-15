package dev.vellum.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * Opens external http(s) links in the platform browser. Dashboard content is
 * untrusted input (architecture §10), so the scheme is re-validated here even
 * though the server already rejected anything that is not http(s): no
 * javascript:, data:, file:, intent: or custom-scheme launches.
 */
object ExternalLinks {
    private const val TAG = "VellumLinks"

    fun isSafe(href: String): Boolean {
        val uri = runCatching { Uri.parse(href) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        if (uri.host.isNullOrBlank()) return false
        if (!uri.userInfo.isNullOrBlank()) return false
        return true
    }

    fun open(context: Context, href: String): Boolean {
        if (!isSafe(href)) {
            Log.w(TAG, "refused to open unsafe link")
            return false
        }
        return runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(href)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        }.getOrElse {
            Log.w(TAG, "no activity for link", it)
            false
        }
    }
}
