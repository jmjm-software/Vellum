package dev.vellum.app.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.updateAll
import dev.vellum.app.ApiClient
import dev.vellum.app.Prefs.clientToken
import dev.vellum.app.Prefs.serverUrl
import dev.vellum.app.ShellStore
import org.json.JSONObject
import java.util.UUID

/**
 * Widget interactions go through the same validated client action endpoint as
 * the web client (dashboard-owned datasets apply directly; mirrored datasets
 * become harness events). Never through a model call.
 */
class PerformToggle : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val dataset = parameters[KEY_DATASET] ?: return
        val item = parameters[KEY_ITEM] ?: return
        post(context, JSONObject()
            .put("type", "toggleItem")
            .put("datasetId", dataset)
            .put("itemId", item)
            .put("idempotencyKey", "widget-toggle-" + UUID.randomUUID()))
    }

    companion object {
        val KEY_DATASET = ActionParameters.Key<String>("dataset")
        val KEY_ITEM = ActionParameters.Key<String>("item")
    }
}

class PerformEvent : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val type = parameters[KEY_TYPE] ?: return
        post(context, JSONObject()
            .put("type", type)
            .put("idempotencyKey", "widget-event-" + UUID.randomUUID()))
    }

    companion object {
        val KEY_TYPE = ActionParameters.Key<String>("eventType")
    }
}

internal suspend fun post(context: Context, body: JSONObject) {
    val url = context.serverUrl
    val token = context.clientToken
    if (url.isBlank() || token.isBlank()) return
    runCatching { ApiClient.postAction(url, token, body.toString()) }
    // Reconcile the displayed state from the server after the action.
    runCatching {
        val raw = ApiClient.getString("$url/api/state", token)
        ShellStore.cacheState(context, raw)
    }
    VellumWidget().updateAll(context)
}