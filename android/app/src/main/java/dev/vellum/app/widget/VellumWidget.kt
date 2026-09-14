package dev.vellum.app.widget

import android.content.Context
import android.graphics.BitmapFactory
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
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
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
import dev.vellum.app.MainActivity
import dev.vellum.app.R
import dev.vellum.app.ShellStore
import dev.vellum.app.dto.ListItemDto
import dev.vellum.app.dto.StateDto
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
    val spec = state?.publication?.content?.widget

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
        } else if (spec == null || spec.components.isEmpty()) {
            Text(
                text = context.getString(R.string.widget_none),
                style = TextStyle(color = ColorProvider(Color(0xFF9AA4AF)))
            )
        } else {
            val size = LocalSize.current
            val budget = when {
                size.height < 200.dp -> 3
                size.height < 300.dp -> 5
                else -> 8
            }
            for (component in spec.components) {
                Render(component, state, budget)
            }
        }
    }
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
            style = TextStyle(color = ColorProvider(if (item.done) Color(0xFF7B8590) else Color(0xFFE6E9EC)))
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
    if (!file.exists()) return
    val bitmap = runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull() ?: return
    Image(
        provider = ImageProvider(bitmap),
        contentDescription = component.alt ?: "",
        modifier = GlanceModifier.fillMaxWidth()
    )
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
        else -> base
    }
    Row(modifier = modifier) {
        Text(component.label.orEmpty(), style = TextStyle(color = ColorProvider(Color(0xFF8AB4F8))))
    }
}

private fun formatNumber(v: Double): String =
    if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else String.format("%.1f", v)