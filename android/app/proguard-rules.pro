# Keep the JavascriptInterface method names (reflection from WebView)
-keepclassmembers class dev.vellum.app.Bridge { @android.webkit.JavascriptInterface <methods>; }
# Keep serialization-generated serializers
-keepclasseswithmembers class dev.vellum.app.dto.** { *; }
