# Android (Kotlin) — OmniStream Mobile (read-only)

## Create the Android Studio project

1. Open Android Studio → **New Project**
2. Choose **Empty Activity** (Jetpack Compose)
3. Name: `OmniStreamMobile`
4. Language: **Kotlin**
5. Minimum SDK: 26+ is fine

## Add dependencies

In `app/build.gradle` add:

- OkHttp (HTTP client)
- kotlinx.serialization (JSON)

Suggested versions (adjust to your project template if needed):
- `com.squareup.okhttp3:okhttp:4.12.0`
- `org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3`

Also enable Kotlin serialization plugin.

### Optional: in-app QR scanning (CameraX + ML Kit)

If you want true in-app QR scanning (instead of using an external camera app and pasting), add:

- Camera permission in `AndroidManifest.xml`:
	- `android.permission.CAMERA`

If this permission is missing, the in-app scanner cannot work and tapping “Grant camera permission” will appear to do nothing (Android will immediately deny the request).

- Make sure your project has `google()` and `mavenCentral()` repositories enabled (usually in `settings.gradle` / `build.gradle`).

- Dependencies in `app/build.gradle` (Module):

```gradle
dependencies {
	// CameraX
	def camerax_version = "1.3.4"
	implementation "androidx.camera:camera-core:${camerax_version}"
	implementation "androidx.camera:camera-camera2:${camerax_version}"
	implementation "androidx.camera:camera-lifecycle:${camerax_version}"
	implementation "androidx.camera:camera-view:${camerax_version}"

	// ML Kit (QR)
	implementation "com.google.mlkit:barcode-scanning:17.3.0"
}
```

## Add the source files

Copy these files into your project under `app/src/main/java/.../`:
- `Config.kt`
- `Api.kt`
- `SettingsStore.kt`
- `MainActivity.kt`
- `PlatformBadge.kt`
- `PlatformIconPreview.kt`
- `QrScannerScreen.kt`

They are located in this repo under:
- `mobile/android/src/`

## Configure the server URL

The app prompts you for the OmniStream base URL on first launch (or via Settings in the app). No code edits are required.

## What you’ll see

- Link device screen (device token)
- Status screen (polls `/api/status` every ~10 seconds) with:
	- Summary (online servers, streams, transcodes)
	- Server list
	- Live sessions list
	- Optional raw JSON toggle

To get a device token, log into the OmniStream web UI and go to:

- System → Mobile devices

## Platform badges

The Live Sessions cards show a top-right **platform badge** (Tautulli-style label tile) like: Roku / Android / iOS / Web / Windows / etc.

- Roku uses the app theme `primary` color with `onPrimary` text (typically a purple tile with white text).
- Other platforms use a neutral surface with a subtle outline.

## Preview platform badges locally

If you use Android Studio, you can preview the platform badges without running the app:

- Open `PlatformIconPreview.kt`
- Use the Compose Preview for `PlatformBadgeRowPreview`
