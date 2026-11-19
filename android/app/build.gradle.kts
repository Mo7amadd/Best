import java.security.MessageDigest
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Xray core for Android (github.com/2dust/AndroidLibXrayLite). Not kept in git: scripts/fetch-libs.mjs
// downloads it, and the build refuses any file whose SHA-256 is not exactly this one.
val libv2rayVersion = "v26.11.9"
val libv2raySha256 = "cdfef146218233a31a8b52c8b1016557730d3b63fc121d4c84cacea50e669155"

// sing-box for Android (github.com/SagerNet/sing-box releases), for configs Xray can't open. Not
// kept in git: scripts/fetch-singbox.mjs unpacks it into src/main/jniLibs, and the build refuses
// any program whose SHA-256 is not listed here.
val singboxVersion = "1.14.4"
val singboxSha256 = mapOf(
    "arm64-v8a/libsingbox.so" to "2ce1c1c2a265e7be21ffa7aaf2b58619986629e9caecfc2d3f80ef4d25b7f965",
    "armeabi-v7a/libsingbox.so" to "92cc0d09897af31e574a17057ba73efdb6626241d876572acb8af2ea552f0ce4",
    "x86_64/libsingbox.so" to "70b41108c986c6049ae4782dae79407f36ba1400c298b62259bd921c4fcfd094",
    "x86/libsingbox.so" to "9dc2b0c817661ce4fcd288217096063e4963598c2013a40479de55b9c8a020d6",
)

// Release signing: a properties file outside the repository (storeFile, storePassword, keyAlias,
// keyPassword), named by the Gradle property "bestSigning" (e.g. in ~/.gradle/gradle.properties).
// Without it a release build is left unsigned.
val signingProps: Properties? = (findProperty("bestSigning") as String?)
    ?.let { File(it) }
    ?.takeIf { it.isFile }
    ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace = "com.best.client"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.best.client"
        minSdk = 24
        targetSdk = 35
        versionCode = 9
        versionName = "1.0.0-beta.9"
        buildConfigField("String", "XRAY_LIB", "\"$libv2rayVersion\"")
        // Best's own updates come only from this repository's releases tagged android-v*.
        buildConfigField("String", "SINGBOX", "\"$singboxVersion\"")
        buildConfigField("String", "UPDATE_REPO", "\"Mo7amadd/Best\"")
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = File(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
                enableV1Signing = false // Android 7+ only: v2 / v3 are enough
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
        }
    }

    splits {
        abi {
            isEnable = true
            reset()
            // x86 (32-bit): BlueStacks and other PC emulators, and old phones with Intel chips.
            include("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
            isUniversalApk = true
        }
    }

    packaging {
        // Native libraries are unpacked at install: sing-box is a program, and Android runs
        // programs only from the app's library folder, never from inside the APK.
        jniLibs.useLegacyPackaging = true
        // sing-box is used exactly as released (its checksum is checked above), not stripped.
        jniLibs.keepDebugSymbols += setOf("**/libsingbox.so", "**/libcronet.so")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    implementation(files("libs/libv2ray.aar"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    // QR codes: reading (camera / photo) and drawing. ZXing core is plain Java, no Google services.
    implementation("com.google.zxing:core:3.5.3")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
}

val verifyXrayLib by tasks.registering {
    description = "Checks the SHA-256 of libs/libv2ray.aar before it is packed into the app."
    val aar = file("libs/libv2ray.aar")
    inputs.file(aar)
    doLast {
        if (!aar.exists()) throw GradleException("libs/libv2ray.aar is missing: run node scripts/fetch-libs.mjs")
        val digest = MessageDigest.getInstance("SHA-256").digest(aar.readBytes()).joinToString("") { "%02x".format(it) }
        if (digest != libv2raySha256) throw GradleException("libs/libv2ray.aar has SHA-256 $digest, expected $libv2raySha256")
    }
}

// The web UI (assets/web) uses the same parsing / config code as the Windows app: src/core is
// bundled into assets/web/gen by scripts/build-web.mjs (plain Node, no extra packages).
val buildWeb by tasks.registering(Exec::class) {
    description = "Bundles the shared Best core and UI files into assets/web/gen."
    workingDir = rootProject.projectDir
    commandLine("node", "scripts/build-web.mjs")
    inputs.dir(rootProject.file("../src/core"))
    inputs.dir(rootProject.file("web"))
    inputs.dir(rootProject.file("../renderer"))
    inputs.file(rootProject.file("scripts/build-web.mjs"))
    outputs.dir(file("src/main/assets/web/gen"))
}

val verifySingBox by tasks.registering {
    description = "Checks the SHA-256 of the sing-box programs in src/main/jniLibs."
    val dir = file("src/main/jniLibs")
    inputs.files(singboxSha256.keys.map { File(dir, it) })
    doLast {
        for ((path, expected) in singboxSha256) {
            val f = File(dir, path)
            if (!f.exists()) throw GradleException("src/main/jniLibs/$path is missing: run node scripts/fetch-singbox.mjs <folder with the sing-box $singboxVersion android archives>")
            val digest = MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }
            if (digest != expected) throw GradleException("src/main/jniLibs/$path has SHA-256 $digest, expected $expected")
        }
    }
}

tasks.named("preBuild") { dependsOn(verifyXrayLib, verifySingBox, buildWeb) }
