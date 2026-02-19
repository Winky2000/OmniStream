# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

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
