# OmniStream Mobile (read-only)

This folder contains **native** iOS and Android client source meant to be dropped into fresh projects.

The app is intentionally minimal:
- Login using `/api/auth/token` (no cookies)
- Poll `/api/status` and show a compact dashboard (summary + servers + live sessions)

No actions/controls are implemented.

## Backend requirements

- OmniStream must be reachable over HTTPS (recommended) from your phone.
- Use the token flow:
  - `POST /api/auth/token { "username": "admin", "password": "..." }` → `{ token }`
  - Call APIs with header: `Authorization: Bearer <token>`

## iOS

See [mobile/ios/README.md](ios/README.md)

## Android

See [mobile/android/README.md](android/README.md)
