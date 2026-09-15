package dev.vellum.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.View
import androidx.glance.appwidget.AppWidgetId
import androidx.test.core.app.ApplicationProvider
import dev.vellum.app.ApiClient
import dev.vellum.app.ShellStore
import dev.vellum.app.dto.StateDto
import java.io.File
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import android.graphics.Color
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue

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
 * `spec.json` is `{ "widget": WidgetSpec, "datasets": Dataset[], "assets": { assetId: base64 } }`.
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

    @After
    fun restoreDecoderSeam() {
        WidgetImages.decode = DEFAULT_DECODER
    }

    @Test
    fun `renders widget previews as png`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val specFile = System.getProperty("vellum.widgetSpec")?.let(::File)
        val specJson = if (specFile != null && specFile.exists()) specFile.readText() else FIXTURE
        val outDir = File(System.getProperty("vellum.outDir") ?: "build/widget-previews").apply { mkdirs() }

        // The renderer consumes exactly what the launcher consumes: the cached
        // state snapshot (publication incl. widget spec + datasets) and prefetched
        // image assets.
        ShellStore.cacheState(context, specJson)
        writeAssets(context, specJson)
        // The fixture references an image; mark it with a colour that appears
        // nowhere else in the widget palette so its pixels are unambiguous.
        WidgetImages.decode = { android.graphics.Bitmap.createBitmap(8, 8, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(Color.MAGENTA) } }
        val specAssets = runCatching {
            (ApiClient.json.parseToJsonElement(specJson) as? kotlinx.serialization.json.JsonObject)
                ?.get("assets")?.let { it as? kotlinx.serialization.json.JsonObject }
                ?.keys?.toList() ?: emptyList()
        }.getOrDefault(emptyList())
        for (assetId in specAssets) {
            File(ShellStore.widgetAssetDir(context), assetId).writeBytes(byteArrayOf(1, 2, 3, 4))
        }

        val state = ApiClient.json.decodeFromString<StateDto>(specJson)
        assertTrue("fixture must contain a widget spec", state.publication?.content?.widget != null)

        // Glance composes widgets through its session machinery, which is backed
        // by WorkManager. Initialize it synchronously for the test (and for the
        // production renderer this is the only environment it runs in).
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor(SynchronousExecutor()).build()
        )

        val appWidgetManager = AppWidgetManager.getInstance(context)
        val appWidgetId = 1

        // Register the widget instance with its provider: Glance resolves the
        // provider/host category through AppWidgetManager.
        val providerInfo = AppWidgetProviderInfo().apply {
            provider = android.content.ComponentName(context, VellumWidgetReceiver::class.java)
            minWidth = 250
            minHeight = 140
        }
        shadowOf(appWidgetManager).addBoundWidget(appWidgetId, providerInfo)

        for ((name, size) in sizes) {
            val (width, height) = size
            // Options drive LocalSize (item budget / compact padding), so they
            // are set per size and the widget is composed again — exactly what a
            // launcher resize does.
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

            runBlocking { VellumWidget().update(context, AppWidgetId(appWidgetId)) }
            val view = awaitRemoteViews(appWidgetManager, appWidgetId)

            view.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
            )
            view.layout(0, 0, width, height)

            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))

            // Pixel proof that the image component reached the widget: scan for
            // the magenta marker the decoder seam produces.
            var magentaPixels = 0
            for (y in 0 until height step 2) {
                for (x in 0 until width step 2) {
                    val pixel = bitmap.getPixel(x, y)
                    if (Color.red(pixel) > 200 && Color.blue(pixel) > 200 && Color.green(pixel) < 80) magentaPixels++
                }
            }
            if (name == "widget-large") {
                assertTrue(
                    "the widget's image component must be drawn into the preview (found $magentaPixels marker pixels)",
                    magentaPixels > 0
                )
            }
            File(outDir, "$name.png").outputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
        }

        val produced = sizes.map { File(outDir, "${it.first}.png") }.filter { it.exists() && it.length() > 0 }
        assertTrue("expected widget previews to be written to ${outDir.absolutePath}", produced.size == sizes.size)

        // Do not leave a Glance session (and its coroutine scope) running: the
        // next test class in the same JVM would inherit it.
        runCatching { WorkManager.getInstance(context).cancelAllWork() }
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
            runCatching {
                return shadowOf(appWidgetManager).getViewFor(appWidgetId)
            }
            Thread.sleep(50)
        }
        error("widget RemoteViews were never produced (session did not compose)")
    }

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
                val bytes = java.util.Base64.getDecoder().decode(base64)
                File(ShellStore.widgetAssetDir(context), assetId).writeBytes(bytes)
            }
        }
    }

    private companion object {
        /** Built-in fixture: a realistic shopping widget (no WidgetSpec -> nothing to render). */
        /** Real decoder, restored after each test. */
        val DEFAULT_DECODER: (File) -> android.graphics.Bitmap? = { file ->
            runCatching {
                val bytes = file.readBytes()
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        }

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
