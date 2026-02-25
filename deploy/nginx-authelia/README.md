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

4) Browse to Nginx:

- `http://YOUR_NGINX_HOST:8080/`

> This example uses **HTTP** on port 8080 to keep it simple.
> For real deployments, put Nginx on HTTPS and set secure cookies in Authelia.

## Notes

- If you already run Nginx on the host (not in Docker), use `deploy/nginx-authelia/nginx/omnistream.conf` as a starting point.
- Keep `/api/status` public only if you need it for monitors. Otherwise, remove the exemption.

## Production hostname example

If your real hostname is `YOUR_OMNISTREAM_DOMAIN`, prefer running Authelia on a dedicated auth subdomain:

- App: `https://YOUR_OMNISTREAM_DOMAIN`
- Auth portal: `https://YOUR_AUTH_DOMAIN`

Templates you can copy and adjust:

- Nginx: `deploy/nginx-authelia/nginx/YOUR_OMNISTREAM_DOMAIN.conf.example`
- Authelia: `deploy/nginx-authelia/authelia/configuration.YOUR_OMNISTREAM_DOMAIN.yml.example`
