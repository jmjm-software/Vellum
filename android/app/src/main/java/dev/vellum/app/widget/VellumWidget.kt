package dev.vellum.app.widget

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
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
import androidx.glance.appwidget.cornerRadius
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
 * text, metric, list, progress, image, link, approved actions.
 *
 * Visual language: one rounded card, 14dp padding (10dp when the host gives us
 * little space), a strict type scale (title 15sp bold / body 13sp / caption
 * 11sp), 8dp between components, hairline dividers between list rows, and
 * pill-shaped action rows. Item counts adapt to the actual allocated size
 * (LocalSize) because launchers disagree about cell dimensions.
 */
class VellumWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { VellumWidgetContent(remember { loadSnapshot(context) }) }
    }
}

/**
 * Bitmap decoding seam. Robolectric's native-graphics mode can create and draw
 * bitmaps but cannot decode image files, so tests substitute this with a fake
 * decoder; production uses the real BitmapFactory path (identical to what the
 * widget has always done).
 */
internal object WidgetImages {
    var decode: (File) -> android.graphics.Bitmap? = { file ->
        runCatching {
            val bytes = file.readBytes()
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
}

internal fun loadSnapshot(context: Context): StateDto? =
    ShellStore.cachedState(context)?.let { raw ->
        runCatching { dev.vellum.app.ApiClient.json.decodeFromString<StateDto>(raw) }.getOrNull()
    }

/** The widget UI. Extracted so native unit tests can render it with a fixture. */
@Composable
internal fun VellumWidgetContent(state: StateDto?) {
    val context = LocalContext.current
    val size = LocalSize.current
    val compact = size.height < 170.dp
    val budget = when {
        size.height < 130.dp -> 2
        size.height < 200.dp -> 3
        size.height < 300.dp -> 5
        else -> 8
    }

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(ImageProvider(R.drawable.widget_background))
            .padding(if (compact) 10.dp else 14.dp)
            .clickable(actionStartActivity<MainActivity>())
    ) {
        if (state == null) {
            Text(
                text = context.getString(R.string.widget_loading),
                style = captionStyle()
            )
            return@Column
        }

        val spec = state.publication?.content?.widget
        val components = when {
            spec != null && spec.components.isNotEmpty() -> spec.components
            // No agent-authored WidgetSpec yet: a conservative starter
            // presentation from the first list/metric dataset, so the launcher
            // widget is useful on any dashboard until an agent designs one.
            else -> starterSpec(state)
        }

        if (components.isEmpty()) {
            Text(text = context.getString(R.string.widget_none), style = captionStyle())
            return@Column
        }

        var first = true
        for (component in components) {
            if (component.kind == "action" && compact && budget <= 2) continue // keep the essentials when tiny
            if (!first) Spacer(GlanceModifier.height(8.dp))
            first = false
            Render(component, state, budget)
        }
    }
}

/** Starter presentation chosen from the dashboard's own data (no WidgetSpec). */
internal fun starterSpec(state: StateDto): List<WidgetComponentDto> {
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

// --- type scale ---------------------------------------------------------------

private fun titleStyle() = TextStyle(
    color = ColorProvider(Color(0xFFF2F4F7)),
    fontWeight = FontWeight.Bold,
    fontSize = 15.sp
)

private fun bodyStyle(done: Boolean = false) = TextStyle(
    color = ColorProvider(if (done) Color(0xFF6E7781) else Color(0xFFE6E9EC)),
    fontSize = 13.sp
)

private fun captionStyle() = TextStyle(color = ColorProvider(Color(0xFF9AA4AF)), fontSize = 11.sp)

private fun accentStyle() = TextStyle(
    color = ColorProvider(Color(0xFF8AB4F8)),
    fontSize = 13.sp,
    fontWeight = FontWeight.Medium
)

private val DIVIDER = Color(0xFF232A31)

// --- rendering -----------------------------------------------------------------

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
}

@Composable
private fun WidgetText(component: WidgetComponentDto) {
    val style = when (component.emphasis) {
        "title" -> titleStyle()
        "caption" -> captionStyle()
        else -> bodyStyle()
    }
    Text(text = component.text.orEmpty(), style = style, maxLines = if (component.emphasis == "caption") 2 else 1)
}

@Composable
private fun WidgetMetric(component: WidgetComponentDto, state: StateDto) {
    val dataset = state.datasets.firstOrNull { it.id == component.dataset }
    val value = dataset?.value?.values?.get(component.field.orEmpty())
    Column {
        if (component.label != null) {
            Text(component.label, style = captionStyle(), maxLines = 1)
            Spacer(GlanceModifier.height(2.dp))
        }
        Row(verticalAlignment = Alignment.Vertical.Bottom) {
            Text(
                text = value?.let { formatNumber(it) } ?: "—",
                style = TextStyle(color = ColorProvider(Color(0xFFF2F4F7)), fontWeight = FontWeight.Bold, fontSize = 20.sp),
                maxLines = 1
            )
            if (component.unit != null) {
                Spacer(GlanceModifier.size(4.dp))
                Text(component.unit, style = captionStyle(), maxLines = 1)
            }
        }
    }
}

@Composable
private fun WidgetList(component: WidgetComponentDto, state: StateDto, budget: Int) {
    val dataset = state.datasets.firstOrNull { it.id == component.dataset }
    val all = dataset?.value?.items.orEmpty()
    val items = if (component.filter == "unchecked") all.filter { !it.done } else all
    if (items.isEmpty()) {
        Text(
            text = if (all.isNotEmpty()) "All done" else "Nothing here yet",
            style = captionStyle(),
            maxLines = 1
        )
        return
    }
    val max = minOf(component.maxItems ?: 4, budget, items.size)
    Column {
        for (i in 0 until max) {
            if (i > 0) Divider()
            ListRow(items[i], component)
        }
        val remaining = items.size - max
        if (component.showRemainingCount == true && remaining > 0) {
            Spacer(GlanceModifier.height(4.dp))
            Text("+$remaining more", style = captionStyle(), maxLines = 1)
        }
    }
}

@Composable
private fun Divider() {
    Spacer(
        modifier = GlanceModifier
            .fillMaxWidth()
            .height(1.dp)
            .background(ColorProvider(DIVIDER))
    )
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
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.Vertical.CenterVertically
    ) {
        Text(
            text = if (item.done) "✓" else "•",
            style = TextStyle(
                color = ColorProvider(if (item.done) Color(0xFF4C8BF5) else Color(0xFF5B8DEF)),
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold
            )
        )
        Spacer(GlanceModifier.size(8.dp))
        Text(text = item.label, style = bodyStyle(item.done), maxLines = 1)
    }
}

@Composable
private fun WidgetProgress(component: WidgetComponentDto, state: StateDto) {
    val dataset = state.datasets.firstOrNull { it.id == component.dataset }
    val items = dataset?.value?.items.orEmpty()
    val done = items.count { it.done }
    val total = items.size
    Column {
        if (component.label != null) {
            Text(component.label, style = captionStyle(), maxLines = 1)
            Spacer(GlanceModifier.height(2.dp))
        }
        Text(
            text = "$done / $total",
            style = TextStyle(color = ColorProvider(Color(0xFFF2F4F7)), fontWeight = FontWeight.Bold, fontSize = 15.sp),
            maxLines = 1
        )
        Spacer(GlanceModifier.height(4.dp))
        // Deterministic block bar (this Glance version has no fraction sizing).
        val blocks = 10
        val filled = if (total > 0) (done.toFloat() / total * blocks).toInt().coerceIn(0, blocks) else 0
        Text(
            text = "▰".repeat(filled) + "▱".repeat(blocks - filled),
            style = TextStyle(color = ColorProvider(Color(0xFF4C8BF5)), fontSize = 11.sp),
            maxLines = 1
        )
    }
}

@Composable
private fun WidgetImage(component: WidgetComponentDto) {
    val context = LocalContext.current
    val assetId = component.assetId ?: return
    val file = File(ShellStore.widgetAssetDir(context), assetId)
    val bitmap = if (file.exists()) WidgetImages.decode(file) else null
    if (bitmap == null) {
        // Visible placeholder rather than silently rendering nothing: the bytes
        // are prefetched by WidgetUpdateWorker, so a missing file means the last
        // sync could not fetch it (offline, revoked token, ...).
        Box(
            modifier = GlanceModifier
                .fillMaxWidth()
                .height(48.dp)
                .background(ImageProvider(R.drawable.widget_action)),
            contentAlignment = Alignment.Center
        ) {
            Text(text = component.alt ?: "image", style = captionStyle(), maxLines = 1)
        }
        return
    }
    Image(
        provider = ImageProvider(bitmap),
        contentDescription = component.alt ?: "",
        contentScale = ContentScale.Fit,
        // Explicit height: an Image with only fillMaxWidth can collapse to zero
        // height in RemoteViews and become invisible. The height comes from the
        // design's size hint (small|medium|large, default medium) so the agent
        // can tune how much room the image takes — it can see the result in the
        // widget previews attached to its review.
        modifier = GlanceModifier
            .fillMaxWidth()
            .height(imageHeight(component.size).dp)
            .cornerRadius(12.dp)
    )
}

@Composable
private fun WidgetLink(component: WidgetComponentDto) {
    val href = component.href ?: return
    if (!ExternalLinks.isSafe(href)) return
    PillRow(
        modifier = GlanceModifier.clickable(
            actionStartActivityIntent(
                Intent(Intent.ACTION_VIEW, Uri.parse(href)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        ),
        label = (component.label ?: href) + " ↗"
    )
}

@Composable
private fun WidgetAction(component: WidgetComponentDto) {
    val action = component.action ?: return
    val modifier = when (action.kind) {
        "openDashboard" -> GlanceModifier.clickable(actionStartActivity<MainActivity>())
        "toggleItem" -> GlanceModifier.clickable(
            actionRunCallback<PerformToggle>(
                actionParametersOf(
                    PerformToggle.KEY_DATASET to action.dataset.orEmpty(),
                    PerformToggle.KEY_ITEM to action.itemId.orEmpty()
                )
            )
        )
        "event" -> GlanceModifier.clickable(
            actionRunCallback<PerformEvent>(
                actionParametersOf(PerformEvent.KEY_TYPE to action.type.orEmpty())
            )
        )
        "openUrl" -> {
            val href = action.href.orEmpty()
            if (!ExternalLinks.isSafe(href)) GlanceModifier
            else GlanceModifier.clickable(
                actionStartActivityIntent(
                    Intent(Intent.ACTION_VIEW, Uri.parse(href)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            )
        }
        else -> GlanceModifier
    }
    PillRow(modifier = modifier, label = component.label.orEmpty())
}

@Composable
private fun PillRow(modifier: GlanceModifier, label: String) {
    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .background(ImageProvider(R.drawable.widget_action))
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .then(modifier),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally
    ) {
        Text(text = label, style = accentStyle(), maxLines = 1)
    }
}

/**
 * Widget image height per design hint. Kept in sync with
 * WIDGET_IMAGE_HEIGHTS in @vellum/core (small 56, medium 96, large 160 dp).
 */
internal fun imageHeight(size: String?): Int = when (size) {
    "small" -> 56
    "large" -> 160
    else -> 96
}

private fun formatNumber(v: Double): String =
    if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else String.format("%.1f", v)

/** Sizes used by the native widget tests (4x2 launcher cell ≈ 250x140dp). */
internal val TEST_WIDGET_SMALL = DpSize(250.dp, 140.dp)
internal val TEST_WIDGET_LARGE = DpSize(320.dp, 320.dp)
