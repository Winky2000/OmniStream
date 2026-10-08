# iOS (SwiftUI) — OmniStream Mobile (read-only)

## Create the Xcode project

1. Open Xcode → **File → New → Project…**
2. Choose **iOS → App**
3. Product Name: `OmniStreamMobile`
4. Interface: **SwiftUI**
5. Language: **Swift**

## Add the source files

Copy these files into your Xcode project (same target):
- `Config.swift`
- `ApiClient.swift`
- `TokenStore.swift`
- `Models.swift`
- `OmniStreamMobileApp.swift`
- `ContentView.swift`

They are located in this repo under:
- `mobile/ios/src/`

## Configure the server URL

Edit `baseURL` in `Config.swift`.

## What you’ll see

- Link device screen (device token)
- Status screen (polls `/api/status` every ~10 seconds) with:
	- Summary (online servers, streams, transcodes)
	- Server list
	- Live sessions list
	- Optional raw JSON disclosure

To get a device token, log into the OmniStream web UI and go to:

- System → Mobile devices
