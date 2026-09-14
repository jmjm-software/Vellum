package dev.vellum.app

import android.content.Context
import java.io.File

/**
 * Disk caches that make the dashboard usable offline (architecture §4:
 * offline clients retain the last usable revision and show staleness):
 *
 *  - bundle/   cached web client assets (index.html and hashed asset files)
 *  - state.json cached GET /api/state payload (last usable publication+data)
 *  - queue.json actions submitted while offline, replayed on reconnect
 *               (server dedupes by idempotencyKey, so replay is safe)
 *  - widget/   cached widget asset bitmaps
 */
object ShellStore {
    private fun bundleDir(ctx: Context) = File(ctx.filesDir, "bundle").apply { mkdirs() }
    private fun cacheDir(ctx: Context) = File(ctx.filesDir, "cache").apply { mkdirs() }
    fun widgetAssetDir(ctx: Context) = File(ctx.filesDir, "widget").apply { mkdirs() }

    private fun stateFile(ctx: Context) = File(cacheDir(ctx), "state.json")
    private fun queueFile(ctx: Context) = File(cacheDir(ctx), "queue.json")

    // --- state cache ---------------------------------------------------------

    fun cacheState(ctx: Context, json: String) {
        runCatching { stateFile(ctx).writeText(json) }
    }

    fun cachedState(ctx: Context): String? = runCatching {
        stateFile(ctx).takeIf { it.exists() }?.readText()
    }.getOrNull()

    // --- web asset bundle ------------------------------------------------------

    fun cacheAsset(ctx: Context, path: String, bytes: ByteArray) {
        val name = path.trimStart('/').replace('/', '_')
        runCatching { File(bundleDir(ctx), name).writeBytes(bytes) }
    }

    fun cachedAsset(ctx: Context, path: String): File? {
        val name = path.trimStart('/').replace('/', '_')
        val f = File(bundleDir(ctx), name)
        return if (f.exists()) f else null
    }

    fun cacheIndex(ctx: Context, html: String) = cacheAsset(ctx, "/index.html", html.toByteArray())
    fun cachedIndex(ctx: Context): File? = cachedAsset(ctx, "/index.html")

    // --- offline action queue ---------------------------------------------------

    data class QueuedAction(val idempotencyKey: String, val body: String)

    fun enqueueAction(ctx: Context, idempotencyKey: String, body: String) {
        synchronized(this) {
            val current = readQueue(ctx).toMutableList()
            if (current.none { it.idempotencyKey == idempotencyKey }) {
                current.add(QueuedAction(idempotencyKey, body))
                writeQueue(ctx, current)
            }
        }
    }

    fun readQueue(ctx: Context): List<QueuedAction> = synchronized(this) {
        val f = queueFile(ctx)
        if (!f.exists()) return emptyList()
        runCatching {
            val arr = org.json.JSONArray(f.readText())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                QueuedAction(o.getString("idempotencyKey"), o.getString("body"))
            }
        }.getOrDefault(emptyList())
    }

    fun dropQueued(ctx: Context, idempotencyKey: String) {
        synchronized(this) {
            writeQueue(ctx, readQueue(ctx).filterNot { it.idempotencyKey == idempotencyKey })
        }
    }

    private fun writeQueue(ctx: Context, items: List<QueuedAction>) {
        val arr = org.json.JSONArray()
        for (item in items) {
            arr.put(
                org.json.JSONObject()
                    .put("idempotencyKey", item.idempotencyKey)
                    .put("body", item.body)
            )
        }
        runCatching { queueFile(ctx).writeText(arr.toString()) }
    }
}
