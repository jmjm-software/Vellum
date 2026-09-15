package dev.vellum.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.glance.appwidget.AppWidgetId
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import dev.vellum.app.ApiClient
import dev.vellum.app.ShellStore
import dev.vellum.app.dto.StateDto
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Native widget preview renderer.
 *
 * Renders the REAL Glance widget (the same composables the launcher hosts, via
 * their RemoteViews) into PNGs at launcher-ish sizes, so widget designs can be
 * *seen* instead of guessed — architecture §4: "when widget editing is enabled,
 * its preview path must exercise the native implementation".
 *
 * Invoked by the preview worker through:
 *   ./gradlew :app:testDebugUnitTest --tests "*WidgetPreviewRendererTest*" \
 *     -Dvellum.widgetSpec=/path/spec.json -Dvellum.outDir=/path/out
 *
 * `spec.json` is the state shape the widget consumes:
 *   { serverTime, publication.content.widget, datasets, assets: { assetId: base64 } }
 * Without system properties it renders a built-in fixture (keeps CI meaningful).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WidgetPreviewRendererTest {

    private val sizes = listOf(
        "widget-small" to (250 to 140), // ~4x2 launcher cell
        "widget-large" to (320 to 320) // ~5x4, resizable
    )

    private val appWidgetId = 1

    @After
    fun restoreDecoderSeam() {
        WidgetImages.decode = DEFAULT_DECODER
    }

    @Test
    fun `renders widget previews as png`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val specJson = specFromSystemPropertiesOrFixture()
        val outDir = File(System.getProperty("vellum.outDir") ?: "build/widget-previews").apply { mkdirs() }

        prepare(context)
        // Only this test's canonical previews may end up in outDir (the review
        // collects widget-*.png from there).
        sizes.forEach { (name, _) -> File(outDir, "$name.png").delete() }

        val state = ApiClient.json.decodeFromString<StateDto>(specJson)
        assertTrue("fixture must contain a widget spec", state.publication?.content?.widget != null)

        var largeMarkers = 0
        for ((name, size) in sizes) {
            val (width, height) = size
            val bitmap = renderWidget(context, specJson, width, height, File(outDir, "$name.png"))
            if (name == "widget-large") largeMarkers = countMarkerPixels(bitmap)
        }

        // Pixel proof that the image component reached the widget.
        assertTrue(
            "the widget's image component must be drawn into the large preview (found $largeMarkers marker pixels)",
            largeMarkers > 0
        )

        val produced = sizes.map { File(outDir, "${it.first}.png") }.filter { it.exists() && it.length() > 0 }
        assertTrue("expected widget previews to be written to ${outDir.absolutePath}", produced.size == sizes.size)

        // Do not leave a Glance session (and its coroutine scope) running.
        runCatching { WorkManager.getInstance(context).cancelAllWork() }
    }

    /**
     * The image `size` hint (small|medium|large) must actually change how much
     * room the image takes — this is what lets an agent fix "the image is too
     * small" by editing the design instead of the app.
     */
    @Test
    fun `image size hint controls the image footprint`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        // Deliberately NOT the configured outDir: the preview worker collects
        // every widget-*.png from there for the review, and these are fixture
        // renders, not previews of the published design.
        val outDir = File("build/widget-previews/fixtures").apply { mkdirs() }
        prepare(context)

        val small = renderWidget(context, imageOnlyFixture("small"), 320, 320, File(outDir, "widget-image-small.png"))
        val large = renderWidget(context, imageOnlyFixture("large"), 320, 320, File(outDir, "widget-image-large.png"))

        val smallMarkers = countMarkerPixels(small)
        val largeMarkers = countMarkerPixels(large)
        assertTrue("small image hint must still render the image (found $smallMarkers)", smallMarkers > 0)
        assertTrue(
            "large image hint must occupy more of the widget than small (small=$smallMarkers, large=$largeMarkers)",
            largeMarkers > smallMarkers * 2
        )

        runCatching { WorkManager.getInstance(context).cancelAllWork() }
    }

    @Test
    fun `image size hints map to bounded heights`() {
        assertTrue(imageHeight("small") < imageHeight(null))
        assertTrue(imageHeight(null) < imageHeight("large"))
        // Unknown/absent hints must fall back to medium, never to something crazy.
        assertTrue(imageHeight("gigantic") == imageHeight(null))
    }

    // --- helpers ---------------------------------------------------------------

    private fun specFromSystemPropertiesOrFixture(): String {
        val specFile = System.getProperty("vellum.widgetSpec")?.let(::File)
        return if (specFile != null && specFile.exists() && specFile.length() > 0) specFile.readText() else FIXTURE
    }

    /**
     * Cache the state, materialise assets, and make the image decoder
     * deterministic. Assets from the built-in fixtures are always materialised
     * too: tests render other specs than the one passed in via
     * -Dvellum.widgetSpec (e.g. the size-hint test), and a missing asset would
     * silently degrade the render to a placeholder.
     */
    private fun prepare(context: Context, specJson: String? = null) {
        val json = specJson ?: specFromSystemPropertiesOrFixture()
        ShellStore.cacheState(context, json)
        writeAssets(context, json)
        writeAssets(context, FIXTURE)
        // Mark the image with a colour that appears nowhere else in the widget
        // palette (Robolectric cannot decode image files).
        WidgetImages.decode = {
            Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.MAGENTA) }
        }
        for (assetId in (assetIdsIn(json) + assetIdsIn(FIXTURE)).distinct()) {
            val file = File(ShellStore.widgetAssetDir(context), assetId)
            if (!file.exists()) file.writeBytes(byteArrayOf(1, 2, 3, 4))
        }
    }

    private fun renderWidget(context: Context, specJson: String, width: Int, height: Int, outFile: File): Bitmap {
        ShellStore.cacheState(context, specJson)
        val appWidgetManager = AppWidgetManager.getInstance(context)
        val providerInfo = AppWidgetProviderInfo().apply {
            provider = android.content.ComponentName(context, VellumWidgetReceiver::class.java)
            minWidth = width
            minHeight = height
        }
        shadowOf(appWidgetManager).addBoundWidget(appWidgetId, providerInfo)

        // Options drive LocalSize (item budget / compact padding), so they are set
        // per size and the widget is composed again — what a launcher resize does.
        appWidgetManager.updateAppWidgetOptions(
            appWidgetId,
            Bundle().apply {
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, height)
                putInt(
                    AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY,
                    AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN
                )
            }
        )

        runBlocking {
            WorkManagerTestInitHelper.initializeTestWorkManager(
                context,
                Configuration.Builder().setExecutor(SynchronousExecutor()).build()
            )
            VellumWidget().update(context, AppWidgetId(appWidgetId))
        }

        val view: View = awaitRemoteViews(appWidgetManager, appWidgetId)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
        )
        view.layout(0, 0, width, height)

        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        outFile.outputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }
        return bitmap
    }

    /** Marker colour used by the decoder seam: magenta appears nowhere else. */
    private fun countMarkerPixels(bitmap: Bitmap): Int {
        var count = 0
        for (y in 0 until bitmap.height step 2) {
            for (x in 0 until bitmap.width step 2) {
                val pixel = bitmap.getPixel(x, y)
                if (Color.red(pixel) > 200 && Color.blue(pixel) > 200 && Color.green(pixel) < 80) count++
            }
        }
        return count
    }

    /**
     * Glance composes through its session machinery (WorkManager + a coroutine
     * scope), so the RemoteViews show up a moment after update() returns: idle
     * the loopers and poll briefly.
     */
    private fun awaitRemoteViews(appWidgetManager: AppWidgetManager, appWidgetId: Int): View {
        repeat(40) {
            shadowOf(android.os.Looper.getMainLooper()).idle()
            org.robolectric.shadows.ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
            runCatching { return shadowOf(appWidgetManager).getViewFor(appWidgetId) }
            Thread.sleep(50)
        }
        error("widget RemoteViews were never produced (session did not compose)")
    }

    private fun assetIdsIn(json: String): List<String> = runCatching {
        (ApiClient.json.parseToJsonElement(json) as? kotlinx.serialization.json.JsonObject)
            ?.get("assets")?.let { it as? kotlinx.serialization.json.JsonObject }
            ?.keys?.toList() ?: emptyList()
    }.getOrDefault(emptyList())

    /** Inline base64 images from the spec into the widget asset cache. */
    private fun writeAssets(context: Context, specJson: String) {
        val assets = runCatching {
            ApiClient.json.parseToJsonElement(specJson)
        }.getOrNull()?.let { root ->
            (root as? kotlinx.serialization.json.JsonObject)
                ?.get("assets")
                ?.let { it as? kotlinx.serialization.json.JsonObject }
        } ?: return

        for ((assetId, value) in assets) {
            val base64 = (value as? kotlinx.serialization.json.JsonPrimitive)?.content ?: continue
            runCatching {
                File(ShellStore.widgetAssetDir(context), assetId).writeBytes(java.util.Base64.getDecoder().decode(base64))
            }
        }
    }

    private companion object {
        /** Real decoder, restored after each test. */
        val DEFAULT_DECODER: (File) -> Bitmap? = { file ->
            runCatching {
                val bytes = file.readBytes()
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        }

        /** A widget that is nothing but an image, so the footprint is unambiguous. */
        fun imageOnlyFixture(size: String): String = """
        {
          "serverTime": 1,
          "publication": {
            "revision": 1,
            "contentHash": "fixture-image",
            "publishedAt": 1,
            "content": {
              "widget": {
                "components": [
                  { "kind": "image", "assetId": "asset_fixture", "alt": "Logo", "size": "$size" }
                ],
                "datasets": []
              }
            }
          },
          "assets": { "asset_fixture": "AQIDBA==" },
          "datasets": []
        }
        """.trimIndent()

        val FIXTURE = """
        {
          "serverTime": 1,
          "publication": {
            "revision": 9,
            "contentHash": "fixture",
            "publishedAt": 1,
            "content": {
              "widget": {
                "components": [
                  { "kind": "text", "text": "Shopping", "emphasis": "title" },
                  { "kind": "list", "dataset": "shopping", "maxItems": 4, "filter": "unchecked", "showRemainingCount": true },
                  { "kind": "progress", "dataset": "shopping", "label": "Done" },
                  { "kind": "image", "assetId": "asset_fixture", "alt": "Logo" },
                  { "kind": "action", "label": "Open dashboard", "action": { "kind": "openDashboard" } }
                ],
                "datasets": ["shopping"]
              }
            }
          },
          "assets": { "asset_fixture": "AQIDBA==" },
          "datasets": [
            {
              "id": "shopping",
              "title": "Shopping",
              "ownership": "dashboard",
              "version": 1,
              "updatedAt": 1,
              "value": {
                "kind": "list",
                "items": [
                  { "id": "milk", "label": "Milk", "done": true },
                  { "id": "bread", "label": "Bread", "done": false },
                  { "id": "coffee", "label": "Coffee beans", "done": false },
                  { "id": "apples", "label": "Apples", "done": false },
                  { "id": "rice", "label": "Rice", "done": false },
                  { "id": "tea", "label": "Tea", "done": true }
                ]
              }
            }
          ]
        }
        """.trimIndent()
    }
}
