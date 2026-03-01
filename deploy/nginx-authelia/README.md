# Nginx + Authelia (2FA) in front of OmniStream

This folder contains an example setup to protect OmniStream with **Nginx + Authelia** (2FA).

## Why this is recommended

OmniStream currently has **no built-in authentication**. If port `3000` is reachable, the UI and write-capable APIs are reachable.
Putting OmniStream behind Nginx + Authelia provides:

- Single sign-on style login page
- 2FA (TOTP)
- Central access policy (protect UI + `/api/*`)

## What this example does

- OmniStream is only reachable on the internal Docker network (no host port published).
- Nginx is the only public entrypoint.
- Authelia enforces authentication for everything **except** `/api/status`.

## Quick start (Docker Compose)

1) Copy the example Authelia files:

- Copy `authelia/configuration.yml.example` to `authelia/configuration.yml`
- Copy `authelia/users_database.yml.example` to `authelia/users_database.yml`

2) Edit `authelia/configuration.yml`:

- Set your `session.secret`, `storage.encryption_key`, and `identity_validation.reset_password.jwt_secret`.
- Set `default_redirection_url` and the `access_control` domain(s).

3) Start the stack:

```bash
docker compose -f deploy/nginx-authelia/docker-compose.yml up -d
```

> This compose file expects host persistence for `config.json`, `history.db`, and `sent_newsletters/`.
> Make sure the host paths exist before first run:
>
> - `config.json` and `history.db` must be regular files (Docker will create directories if they don't exist).
> - `sent_newsletters` must be a directory.
>
> You can override locations with `CONFIG_PATH`, `HISTORY_DB_PATH`, `SERVERS_PATH`, and `SENT_NEWSLETTERS_PATH`.

4) Browse to Nginx:

- `http://YOUR_NGINX_HOST:8080/`

> This example uses **HTTP** on port 8080 to keep it simple.
> For real deployments, put Nginx on HTTPS and set secure cookies in Authelia.

## Notes

- If you already run Nginx on the host (not in Docker), use `deploy/nginx-authelia/nginx/omnistream.conf` as a starting point.
- Keep `/api/status` public only if you need it for monitors. Otherwise, remove the exemption.
- Newsletter state (Subscribers + Sent history) lives in `history.db` and `sent_newsletters/`. If these aren't persisted, those pages will look empty after container recreates.

### Newsletter posters in emails

If you enable newsletter posters, email clients will fetch images without any browser session/cookies.
This means your gateway (Authelia) must allow access to the **signed** image proxy endpoints:

- `/api/poster/signed`
- `/api/newsletter/plex/thumb/signed`

The provided Nginx configs already exempt these paths from `auth_request`.

## Production hostname example

If your real hostname is `YOUR_OMNISTREAM_DOMAIN`, prefer running Authelia on a dedicated auth subdomain:

- App: `https://YOUR_OMNISTREAM_DOMAIN`
- Auth portal: `https://YOUR_AUTH_DOMAIN`

Templates you can copy and adjust:

- Nginx: `deploy/nginx-authelia/nginx/YOUR_OMNISTREAM_DOMAIN.conf.example`
- Authelia: `deploy/nginx-authelia/authelia/configuration.YOUR_OMNISTREAM_DOMAIN.yml.example`
