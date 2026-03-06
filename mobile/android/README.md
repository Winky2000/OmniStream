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
- `TokenStore.kt`
- `MainActivity.kt`

They are located in this repo under:
- `mobile/android/src/`

## Configure the server URL

Edit `BASE_URL` in `Config.kt`.

## What you’ll see

- Login screen (username/password)
- Status screen (polls `/api/status` every ~10 seconds) with:
	- Summary (online servers, streams, transcodes)
	- Server list
	- Live sessions list
	- Optional raw JSON toggle

If OmniStream returns `mustChangePassword: true` during login, use the web UI to change it.
