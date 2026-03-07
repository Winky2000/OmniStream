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

## Add the source files

Copy these files into your project under `app/src/main/java/.../`:
- `Config.kt`
- `Api.kt`
- `SettingsStore.kt`
- `MainActivity.kt`

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

- Settings → System → Tools → Mobile devices
