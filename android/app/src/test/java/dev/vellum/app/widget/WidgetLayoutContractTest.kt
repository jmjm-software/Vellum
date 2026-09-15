package dev.vellum.app.widget

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contract between the shared widget layout tokens and the Kotlin renderer.
 *
 * `packages/core/src/widget-layout.json` is the single source of truth: the
 * TypeScript mirror used for the lightweight previews reads it directly, and the
 * native Glance renderer must agree with it. This test fails loudly when the
 * numbers drift apart (a drifted token would make previews lie about the widget).
 *
 * Note: parsed with kotlinx.serialization, not org.json — under
 * `unitTests.isReturnDefaultValues = true` the org.json classes resolved from the
 * SDK stub return null for every method, which silently yields empty objects.
 */
class WidgetLayoutContractTest {

    private val layoutFile: File by lazy {
        // Walk up from the test working directory until the repo root shows up:
        // Gradle's cwd differs between IDE, CLI and CI runs.
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "packages/core/src/widget-layout.json")
            if (candidate.exists()) return@lazy candidate
            dir = dir.parentFile
        }
        error("packages/core/src/widget-layout.json not found above ${File("").absolutePath}")
    }

    private val layout: JsonObject by lazy {
        val parsed = Json.parseToJsonElement(layoutFile.readText()).jsonObject
        require(parsed.containsKey("profiles")) {
            "shared widget layout is missing 'profiles' (${layoutFile.absolutePath})"
        }
        parsed
    }

    private fun JsonObject.int(path: String): Int = intAt(path.split("."))
    private fun JsonObject.intAt(keys: List<String>): Int =
        (keys.dropLast(1).fold(this) { acc, key -> acc.getValue(key).jsonObject }
            .getValue(keys.last()).jsonPrimitive.int)

    @Test
    fun `native image heights match the shared tokens`() {
        assertEquals(layout.int("imageHeights.small"), imageHeight("small"))
        assertEquals(layout.int("imageHeights.medium"), imageHeight(null))
        assertEquals(layout.int("imageHeights.large"), imageHeight("large"))
        assertEquals(layout.int("imageHeights.medium"), imageHeight("medium"))
        // unknown hints fall back to medium, never to something unbounded
        assertEquals(layout.int("imageHeights.medium"), imageHeight("gigantic"))
    }

    @Test
    fun `preview profile sizes match the shared tokens and the native tests`() {
        assertEquals(250, layout.int("profiles.widget-small.width"))
        assertEquals(140, layout.int("profiles.widget-small.height"))
        assertEquals(320, layout.int("profiles.widget-large.width"))
        assertEquals(320, layout.int("profiles.widget-large.height"))
        // the mirror profiles, the native renderer tests and the launcher sizes must agree
        assertEquals(layout.int("profiles.widget-small.width"), TEST_WIDGET_SMALL.width.value.toInt())
        assertEquals(layout.int("profiles.widget-small.height"), TEST_WIDGET_SMALL.height.value.toInt())
        assertEquals(layout.int("profiles.widget-large.width"), TEST_WIDGET_LARGE.width.value.toInt())
        assertEquals(layout.int("profiles.widget-large.height"), TEST_WIDGET_LARGE.height.value.toInt())
    }

    @Test
    fun `list budget and padding tokens are bounded and sane`() {
        val under130 = layout.int("budget.under130")
        val under200 = layout.int("budget.under200")
        val under300 = layout.int("budget.under300")
        val otherwise = layout.int("budget.else")
        assertTrue(under130 < under200)
        assertTrue(under200 < under300)
        assertTrue(under300 <= otherwise)
        assertTrue("compact padding must be smaller than the regular one", layout.int("padding") > layout.int("compactPadding"))
        assertTrue("a launcher widget must not show an unbounded list", layout.int("maxListItems") <= 10)
    }
}
