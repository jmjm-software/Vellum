package dev.vellum.app.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.glance.appwidget.updateAll

/**
 * Renders all widget instances from the currently cached snapshot. Unlike
 * WidgetUpdateWorker this performs NO network I/O — it is the fast path used
 * when the web client reports a fresh /api/state over the bridge, so the
 * launcher widget updates within moments of any dashboard change (design
 * publish, dataset update, action) while the app is in use.
 */
class WidgetRenderWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return try {
            VellumWidget().updateAll(applicationContext)
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 2) Result.retry() else Result.failure()
        }
    }

    companion object {
        private const val UNIQUE = "vellum-widget-render"

        fun refresh(context: Context) {
            val req = OneTimeWorkRequestBuilder<WidgetRenderWorker>().build()
            WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.REPLACE, req)
        }
    }
}