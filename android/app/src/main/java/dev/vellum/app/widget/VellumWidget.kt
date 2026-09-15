package dev.vellum.app.widget

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.actionParametersOf
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity as actionStartActivityIntent
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.vellum.app.ExternalLinks
import dev.vellum.app.MainActivity
import dev.vellum.app.R
import dev.vellum.app.ShellStore
import dev.vellum.app.dto.ListItemDto
import dev.vellum.app.dto.StateDto
import dev.vellum.app.dto.WidgetActionDto
import dev.vellum.app.dto.WidgetComponentDto
import java.io.File

/**
 * Native launcher widget: an agent-designed compact presentation of the same
 * datasets (architecture §4). Deliberately small trusted catalogue:
 * text, metric, list, progress, image, approved actions.
 *
 * Sizing: launchers disagree about cell dimensions, so item counts adapt to
 * the actual allocated size (LocalSize) instead of assuming a fixed grid.
 */
class VellumWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { WidgetContent() }
    }
}

@Composable
private fun WidgetContent() {
    val context = LocalContext.current
    val state = remember { loadSnapshot(context) }

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(ColorProvider(Color(0xFF14181D)))
            .padding(12.dp)
            .clickable(actionStartActivity<MainActivity>())
    ) {
        if (state == null) {
            Text(
                text = context.getString(R.string.widget_loading),
                style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF)))
            )
        } else {
            val size = LocalSize.current
            val budget = when {
                size.height < 200.dp -> 3
                size.height < 300.dp -> 5
                else -> 8
            }
            val spec = state.publication?.content?.widget
            val components = when {
                spec != null && spec.components.isNotEmpty() -> spec.components
                // No agent-authored WidgetSpec yet: conservative starter
                // presentation from the first list/metric dataset, so the
                // launcher widget is useful on any dashboard and the agent can
                // replace or refine it later. Architecture §4 keeps the widget
                // a small presentation of the same datasets — this is the same
                // renderer, driven by a synthesized spec.
                else -> starterSpec(state)
            }
            for (component in components) {
                Render(component, state, budget)
            }
            if (components.isEmpty()) {
                Text(
                    text = context.getString(R.string.widget_none),
                    style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF)))
                )
            }
        }
    }
}

/** Starter presentation chosen from the dashboard's own data (used only when
 *  the published design carries no WidgetSpec). */
private fun starterSpec(state: StateDto): List<WidgetComponentDto> {
    val openAction = WidgetComponentDto(
        kind = "action",
        label = "Open dashboard",
        action = WidgetActionDto(kind = "openDashboard")
    )
    val list = state.datasets.firstOrNull { it.value?.kind == "list" }
    if (list != null) {
        return listOf(
            WidgetComponentDto(kind = "text", text = list.title.ifBlank { list.id }, emphasis = "title"),
            WidgetComponentDto(kind = "list", dataset = list.id, maxItems = 4, filter = "unchecked", showRemainingCount = true),
            openAction
        )
    }
    val metric = state.datasets.firstOrNull { it.value?.kind == "metric" }
    if (metric != null) {
        val field = metric.value?.values?.keys?.firstOrNull()
        if (field != null) {
            return listOf(
                WidgetComponentDto(kind = "text", text = metric.title.ifBlank { metric.id }, emphasis = "title"),
                WidgetComponentDto(kind = "metric", dataset = metric.id, field = field, label = field),
                openAction
            )
        }
    }
    return emptyList()
}

private fun loadSnapshot(context: Context): StateDto? =
    ShellStore.cachedState(context)?.let { raw ->
        runCatching { dev.vellum.app.ApiClient.json.decodeFromString<StateDto>(raw) }.getOrNull()
    }

@Composable
private fun Render(component: WidgetComponentDto, state: StateDto, budget: Int) {
    when (component.kind) {
        "text" -> WidgetText(component)
        "metric" -> WidgetMetric(component, state)
        "list" -> WidgetList(component, state, budget)
        "progress" -> WidgetProgress(component, state)
        "image" -> WidgetImage(component)
        "link" -> WidgetLink(component)
        "action" -> WidgetAction(component)
        else -> Unit // unknown widget kinds render nothing (forward compat)
    }
    Spacer(modifier = GlanceModifier.height(6.dp))
}

// --- catalogue ---------------------------------------------------------------

@Composable
private fun WidgetText(component: WidgetComponentDto) {
    val style = when (component.emphasis) {
        "title" -> TextStyle(color = ColorProvider(Color.White), fontWeight = FontWeight.Bold, fontSize = 16.sp)
        "caption" -> TextStyle(color = ColorProvider(Color(0xFF9AA4AF)), fontSize = 11.sp)
        else -> TextStyle(color = ColorProvider(Color(0xFFE6E9EC)), fontSize = 13.sp)
    }
    Text(text = component.text.orEmpty(), style = style)
}

@Composable
private fun WidgetMetric(component: WidgetComponentDto, state: StateDto) {
    val dataset = state.datasets.firstOrNull { it.id == component.dataset }
    val value = dataset?.value?.values?.get(component.field.orEmpty())
    Row(verticalAlignment = Alignment.Vertical.CenterVertically) {
        if (component.label != null) {
            Text(component.label, style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF))))
            Spacer(GlanceModifier.size(6.dp))
        }
        Text(
            text = (value?.let { formatNumber(it) } ?: "—") + (component.unit?.let { " $it" } ?: ""),
            style = TextStyle(color = ColorProvider(Color.White), fontWeight = FontWeight.Bold)
        )
    }
}

@Composable
private fun WidgetList(component: WidgetComponentDto, state: StateDto, budget: Int) {
    val dataset = state.datasets.firstOrNull { it.id == component.dataset }
    val items = dataset?.value?.items.orEmpty()
        .let { if (component.filter == "unchecked") it.filter { item -> !item.done } else it }
    val max = minOf(component.maxItems ?: 4, budget)
    for (item in items.take(max)) {
        ListRow(item, component)
    }
    if (component.showRemainingCount == true && items.size > max) {
        Text(
            "+${items.size - max} more",
            style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF)))
        )
    }
}

@Composable
private fun ListRow(item: ListItemDto, component: WidgetComponentDto) {
    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .clickable(
                actionRunCallback<PerformToggle>(
                    actionParametersOf(
                        PerformToggle.KEY_DATASET to component.dataset.orEmpty(),
                        PerformToggle.KEY_ITEM to item.id
                    )
                )
            )
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.Vertical.CenterVertically
    ) {
        Text(
            text = if (item.done) "✓ " else "• ",
            style = TextStyle(color = ColorProvider(if (item.done) Color(0xFF4C8BF5) else Color(0xFF9AA4AF)))
        )
        Text(
            text = item.label,
            style = TextStyle(color = ColorProvider(if (item.done) Color(0xFF7B8590) else Color(0xFFE6E9EC))),
            maxLines = 1
        )
    }
}

@Composable
private fun WidgetProgress(component: WidgetComponentDto, state: StateDto) {
    val dataset = state.datasets.firstOrNull { it.id == component.dataset }
    val items = dataset?.value?.items.orEmpty()
    val done = items.count { it.done }
    val total = items.size
    if (component.label != null) {
        Text(component.label, style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF))))
    }
    Text("$done / $total", style = TextStyle(color = ColorProvider(Color.White)))
    // Deterministic block bar (this Glance version has no fraction-based sizing).
    val blocks = 10
    val filled = if (total > 0) (done.toFloat() / total * blocks).toInt().coerceIn(0, blocks) else 0
    Text(
        text = "▰".repeat(filled) + "▱".repeat(blocks - filled),
        style = TextStyle(color = ColorProvider(Color(0xFF4C8BF5)))
    )
}

@Composable
private fun WidgetImage(component: WidgetComponentDto) {
    val context = LocalContext.current
    val assetId = component.assetId ?: return
    val file = File(ShellStore.widgetAssetDir(context), assetId)
    val bitmap = if (file.exists()) runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull() else null
    if (bitmap == null) {
        // Visible placeholder rather than silently rendering nothing: the bytes
        // are prefetched by WidgetUpdateWorker, so a missing file means the
        // last sync could not fetch it (offline, revoked token, ...).
        Box(
            modifier = GlanceModifier
                .fillMaxWidth()
                .height(40.dp)
                .background(ColorProvider(Color(0xFF232A31)))
                .padding(8.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = component.alt ?: "image",
                style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF))),
                maxLines = 1
            )
        }
        return
    }
    Image(
        provider = ImageProvider(bitmap),
        contentDescription = component.alt ?: "",
        contentScale = ContentScale.Fit,
        // Explicit height: an Image with only fillMaxWidth can collapse to zero
        // height in RemoteViews and become invisible.
        modifier = GlanceModifier
            .fillMaxWidth()
            .height(96.dp)
    )
}

@Composable
private fun WidgetLink(component: WidgetComponentDto) {
    val href = component.href ?: return
    if (!ExternalLinks.isSafe(href)) return
    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .clickable(
                actionStartActivityIntent(
                    Intent(Intent.ACTION_VIEW, Uri.parse(href)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            )
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.Vertical.CenterVertically
    ) {
        Text(
            text = (component.label ?: href) + " ↗",
            style = TextStyle(color = ColorProvider(Color(0xFF8AB4F8)))
        )
    }
}

@Composable
private fun WidgetAction(component: WidgetComponentDto) {
    val action = component.action ?: return
    val base = GlanceModifier
        .fillMaxWidth()
        .background(ColorProvider(Color(0xFF232A31)))
        .padding(8.dp)
    val modifier = when (action.kind) {
        "openDashboard" -> base.clickable(actionStartActivity<MainActivity>())
        "toggleItem" -> base.clickable(
            actionRunCallback<PerformToggle>(
                actionParametersOf(
                    PerformToggle.KEY_DATASET to action.dataset.orEmpty(),
                    PerformToggle.KEY_ITEM to action.itemId.orEmpty()
                )
            )
        )
        "event" -> base.clickable(
            actionRunCallback<PerformEvent>(
                actionParametersOf(PerformEvent.KEY_TYPE to action.type.orEmpty())
            )
        )
        "openUrl" -> {
            val href = action.href.orEmpty()
            if (!ExternalLinks.isSafe(href)) base else base.clickable(
                actionStartActivityIntent(
                    Intent(Intent.ACTION_VIEW, Uri.parse(href)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            )
        }
        else -> base
    }
    Row(modifier = modifier) {
        Text(component.label.orEmpty(), style = TextStyle(color = ColorProvider(Color(0xFF8AB4F8))))
    }
}

private fun formatNumber(v: Double): String =
    if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else String.format("%.1f", v)