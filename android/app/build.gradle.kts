plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.vellum.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.vellum.app"
        minSdk = 26
        targetSdk = 35
        // Bump versionCode for EVERY app change: Android only installs an APK
        // over an existing app when the versionCode increases (otherwise the
        // install fails and the old app must be uninstalled first).
        // versionName is the human-readable counterpart.
        versionCode = 8
        versionName = "0.1.7"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = true
    }
}

// The widget preview renderer is driven by -Dvellum.widgetSpec / -Dvellum.outDir:
// forward them into the test JVM and never treat the render task as up to date
// (the inputs are properties, not files Gradle tracks).
tasks.withType<Test>().configureEach {
    listOf("vellum.widgetSpec", "vellum.outDir").forEach { key ->
        System.getProperty(key)?.let { systemProperty(key, it) }
    }
    outputs.upToDateWhen { false }
    // Each test class gets a fresh JVM: the widget preview renderer drives
    // Glance's session machinery (WorkManager + long-lived coroutine scopes),
    // and leftovers from it make the pure compose tests flaky within a shared
    // JVM (kotlinx.coroutines.test.UncompletedCoroutinesError).
    forkEvery = 1
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Glance launcher widgets (widget-specific APIs, deliberately not full Compose UI)
    implementation("androidx.glance:glance-appwidget:1.1.1")

    // Native widget rendering tests (Robolectric + Glance's own test harness):
    // they render the real RemoteViews tree, no emulator and no browser stand-in.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.glance:glance-appwidget-testing:1.1.1")
    testImplementation("androidx.glance:glance-testing:1.1.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("androidx.work:work-testing:2.10.0")
}
