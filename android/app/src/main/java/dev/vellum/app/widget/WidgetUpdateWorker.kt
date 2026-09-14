package dev.vellum.app.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.vellum.app.ApiClient
import dev.vellum.app.Prefs.clientToken
import dev.vellum.app.Prefs.serverUrl
import dev.vellum.app.ShellStore
import java.io.File
import java.util.concurrent.TimeUnit
import androidx.glance.appwidget.updateAll

/**
 * Keeps the widget snapshot fresh: fetches /api/state (publication incl. the
 * agent-designed WidgetSpec + datasets), caches it for offline shell use,
 * prefetches widget asset images, then updates all widget instances.
 *
 * Continuous freshness beyond this cadence is a harness/server concern
 * (architecture §9); the widget never blocks on the network.
 */
class WidgetUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val url = ctx.serverUrl
        val token = ctx.clientToken
        if (url.isBlank() || token.isBlank()) return Result.success()

        return try {
            val state = ApiClient.getState(url, token)
            val raw = ApiClient.getString("$url/api/state", token)
            ShellStore.cacheState(ctx, raw)

            // Prefetch widget image assets so the native widget can render them
            // without a network round trip.
            val assets = state.publication?.content?.widget?.components
                ?.mapNotNull { it.assetId } ?: emptyList()
            for (assetId in assets) {
                val target = File(ShellStore.widgetAssetDir(ctx), assetId)
                if (!target.exists()) {
                    runCatching {
                        target.writeBytes(ApiClient.getBytes("$url/api/assets/$assetId", token))
                    }
                }
            }

            VellumWidget().updateAll(ctx)
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 2) Result.retry() else Result.success() // stay quiet offline
        }
    }

    companion object {
        private const val PERIODIC = "vellum-widget-periodic"
        private const val ONESHOT = "vellum-widget-oneshot"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<WidgetUpdateWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req
            )
        }

        fun runOnce(context: Context) {
            val req = OneTimeWorkRequestBuilder<WidgetUpdateWorker>().build()
            WorkManager.getInstance(context).enqueueUniqueWork(ONESHOT, ExistingWorkPolicy.REPLACE, req)
        }
    }
}
