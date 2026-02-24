# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## [Unreleased]

_No unreleased changes yet._

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
[Unreleased]: https://github.com/Winky2000/OmniStream/compare/v0.2.3...HEAD
