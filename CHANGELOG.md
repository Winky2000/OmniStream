# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## [Unreleased]

_No unreleased changes yet._

## [0.3.8] - 2026-03-01
- Fix Plex history import by explicitly requesting JSON and surfacing per-server errors when Plex returns unexpected responses.

## [0.3.7] - 2026-03-02

### Fixed
- Subscribers: “Tag by server” now supports stable subscriber keys (`watchUserKey` like `plex:<id>`) and matches against both `history.userKey` and `history.user` to improve reliability.
- History polling/import: store stable user keys for Plex/Jellyfin/Emby when user IDs are available.
- History import: Jellyfin/Emby import now uses the correct auth header/query param for Emby vs Jellyfin (fixes “Import History from Servers” for Emby setups).

## [0.3.6] - 2026-03-01

### Added
- Subscribers: server-scoped newsletter sends now automatically recompute “Tag by server” first (default lookback: 365 days) to keep recipients accurate without manual pulls.

## [0.3.5] - 2026-03-01

### Fixed
- Subscribers: “Tag by server” now prefers a stable `history.userKey` (when available) instead of relying only on friendly display names.
- Plex sessions: exposes a better per-session username value so history can store a stable user key for matching.
- Overseerr import: improved display-name mapping (uses Plex user title when available).

## [0.3.4] - 2026-03-01

### Fixed
- Subscribers: Overseerr import now stores display name separately from watch username so “Tag by server” can match watch history more reliably.
- Subscribers: “Tag by server” now tries multiple subscriber keys (watchUser and name) and batches queries to avoid SQLite variable limits.

## [0.3.3] - 2026-02-28

### Fixed
- Newsletter: Sent history no longer appears blank when saved subjects contain spaces/punctuation.

## [0.3.2] - 2026-02-28

### Added
- Newsletter: sent-newsletter history API + UI page for browsing previously sent newsletters.
- Newsletter/email images: signed, time-limited image URLs plus signed-only endpoints designed for safe reverse-proxy auth bypass.

### Changed
- Newsletter “Recently Added” rendering: poster centered above text; TV episodes are grouped by show and listed as `SxxExx - Title`.
- Newsletter custom header sections: supports multi-row sections with per-row background/text colors and improved alignment.

### Fixed
- SMTP settings: config round-trip no longer drops SMTP fields; password updates are merge-safe (blank password preserves existing).
- Startup: tolerate UTF-8 BOM when parsing `package.json`.
- Deployment docs/examples: Nginx Basic Auth and Nginx + Authelia examples exempt only signed image endpoints for email clients.

## [0.3.1] - 2026-02-27

### Added
- New **At a glance** page for a compact multi-server view.

### Changed
- Frontend shell/sidebar CSS + wiring is deduplicated into shared assets (shell.css / shell.js).

### Fixed
- Prevent overlapping polling runs when a poll takes longer than the interval.
- Docker Compose now persists history.db so history survives container rebuilds.

## [0.3.0] - 2026-02-24

### Added
- Internal authentication (built-in login) with a required password change on first login.
- Settings toggle for authentication mode: **Internal** vs **Nginx** (disables internal auth completely for reverse-proxy/2FA setups).
- Auth troubleshooting controls: `OMNISTREAM_RESET_INTERNAL_AUTH` (reset to defaults) and `OMNISTREAM_AUTH_DEBUG` (debug logging).

### Changed
- Sidebar menus standardized across all pages and include a Logout link.
- Dependency security: npm override pins `tar` to a patched version to resolve audit findings.

### Fixed
- Windows test/start scripts now have `servers.test.json` available on fresh clones.

## [0.2.3] - 2026-02-23

### Added
- Newsletter: server-scoped manual send and preview (pick a server; sends only to subscribers tagged for that server).
- Newsletter: per-server automated schedules (multiple schedules, each optionally scoped to a server).
- Newsletter: unified “Recently Added” across Plex + Jellyfin + Emby.
- System setting: configurable public base URL to generate absolute image URLs in newsletter emails.
- Deployment examples: Nginx Basic Auth and Nginx + Authelia (2FA) configs and docs.

### Changed
- Default newsletter template now uses `{{SERVER_NAME}}` instead of a hard-coded header/title.
- Windows PowerShell scripts improved to find `node.exe` even when Node isn’t on PATH.
- Local newsletter upload assets are now ignored via `.gitignore` (prevents committing `public/uploads`).

### Fixed
- Settings sidebar submenu toggles no longer open the wrong submenu on some pages.
- Newsletter header now matches the selected server in server-scoped previews/sends.

### Security
- CORS is disabled by default; cross-origin API access requires an explicit `OMNISTREAM_CORS_ORIGINS` allowlist.

## [0.2.2] - 2026-02-22

### Added
- Newsletter “Recently Added” now shows totals for movies and TV (unique shows + seasons) for the selected date window.

## [0.2.1] - 2026-02-22

### Fixed
- Docker publishing: stable version tags now also publish the `latest` image tag so `ghcr.io/...:latest` matches the newest non-beta release.

## [0.2.0] - 2026-02-22

### Added
- Newsletter system: subscribers, templates, preview/send endpoints, and sent-newsletter archiving.
- Custom template header blocks editor (separate page) with automatic placement under the logo/header.
- Weekly newsletter auto-send scheduling (day/time + template).
- About page showing version and GitHub links.
- Randomized GitHub release checks with an in-app update-available notice.

### Changed
- Newsletter default template refreshed to a darker style.
- Reports: Most Popular Movies panel now shows the top movie poster.

## [0.1.1] - 2026-02-21

### Added
- Per-server scope dropdown on the Reports page to view activity and top titles/users for a single server or all servers.
- Lightweight `/api/health` endpoint for external monitors (Home Assistant, Uptime Kuma).
- Session card enhancements: richer media details, user avatars (Plex + Jellyfin/Emby), and transcode progress overlay on the playback bar.
- Global header summary now shows aggregate bandwidth across all servers (total + WAN).

### Changed
- Reports now count deduplicated "play events" instead of every poll row, so long-running sessions are not over-counted.
- History retention is configurable via `config.json` (`maxHistory`), with support for disabling trimming to keep full history.
- Dashboard layout and styling improved for consistency across settings pages and horizontal/vertical layouts.

## [0.1.0] - 2026-02-18

### Added
- Initial public release of OmniStream.
- Multi-server dashboard for Plex, Jellyfin, and Emby with active session cards and bandwidth stats.
- Per-server status, history storage, and reports page (overview, top users/titles, 7-day activity, busiest day/hour).
- Read-only monitoring model; no changes are made to media libraries or playback.
- Notification channels: Discord, generic webhook, Slack, Telegram, SMS (Twilio), Pushover, Gotify, and Email.
- Global notification rules (offline servers, WAN transcodes, high total bandwidth) and per-channel triggers.
- Notifiers test endpoint and "Send test notification" button.
- Sidebar-based UI with Settings subpages (Servers, Themes & layout, Notifiers) and a setup experience when no servers are configured.

[0.1.0]: https://github.com/Winky2000/OmniStream/releases/tag/v0.1.0
[0.1.1]: https://github.com/Winky2000/OmniStream/releases/tag/v0.1.1
[0.2.0]: https://github.com/Winky2000/OmniStream/releases/tag/v0.2.0
[0.2.1]: https://github.com/Winky2000/OmniStream/releases/tag/v0.2.1
[0.2.2]: https://github.com/Winky2000/OmniStream/releases/tag/v0.2.2
[0.2.3]: https://github.com/Winky2000/OmniStream/releases/tag/v0.2.3
[0.3.0]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.0
[0.3.1]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.1
[0.3.2]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.2
[0.3.3]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.3
[0.3.4]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.4
[0.3.5]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.5
[0.3.6]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.6
[0.3.8]: https://github.com/Winky2000/OmniStream/releases/tag/v0.3.8
[Unreleased]: https://github.com/Winky2000/OmniStream/compare/v0.3.6...HEAD
