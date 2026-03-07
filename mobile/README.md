# OmniStream Mobile (read-only)

This folder contains **native** iOS and Android client source meant to be dropped into fresh projects.

The app is intentionally minimal:
- Link the device using a server-generated device token (created from the OmniStream web UI)
- Poll `/api/status` and show a compact dashboard (summary + servers + live sessions)

No actions/controls are implemented.

## Backend requirements

- OmniStream must be reachable over HTTPS (recommended) from your phone.
- Create a **mobile device token** in the OmniStream web UI after login:
  - Settings → System → Tools → Mobile devices
- Paste that token into the mobile app.
- Call APIs with header: `Authorization: Bearer <deviceToken>`

## iOS

See [mobile/ios/README.md](ios/README.md)

## Android

See [mobile/android/README.md](android/README.md)
