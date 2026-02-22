# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## [Unreleased]

_No unreleased changes yet._

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

[0.1.0]: https://github.com/winky2000/omnistream/releases/tag/v0.1.0
[0.1.1]: https://github.com/winky2000/omnistream/releases/tag/v0.1.1
[Unreleased]: https://github.com/winky2000/omnistream/compare/v0.1.1...HEAD
