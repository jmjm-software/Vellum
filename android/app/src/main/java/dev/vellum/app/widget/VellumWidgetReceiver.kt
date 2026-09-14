package dev.vellum.app.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.updateAll

class VellumWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = VellumWidget()
}

/** Refresh helper shared by workers and widget actions. */
suspend fun refreshWidget(context: Context, glanceId: GlanceId? = null) {
    val widget = VellumWidget()
    if (glanceId != null) widget.update(context, glanceId) else widget.updateAll(context)
}
