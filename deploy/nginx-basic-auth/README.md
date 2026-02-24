# Nginx Basic Auth (username/password) in front of OmniStream

This is a **simple stopgap** to protect OmniStream with **Nginx HTTP Basic Authentication**.

It is not as strong or user-friendly as a real SSO/2FA gateway (Authelia/Authentik), but it is a big improvement over running OmniStream unauthenticated.

## Recommended network layout

- Public entrypoint: **Nginx**
- Upstream app: OmniStream on a private/LAN address
- Firewall: only Nginx can reach OmniStream’s port (typically `3000`)

## Create a password file

On the Nginx host, create an `htpasswd` file.

### Option A: apache2-utils (recommended)

```bash
sudo apt-get update
sudo apt-get install -y apache2-utils

sudo htpasswd -c /etc/nginx/.htpasswd omnistream_admin
```

- You will be prompted for a password.
- Add additional users (without `-c`):

```bash
sudo htpasswd /etc/nginx/.htpasswd another_user
```

### Option B: OpenSSL (if you don’t have htpasswd)

```bash
printf "omnistream_admin:$(openssl passwd -apr1)\n" | sudo tee /etc/nginx/.htpasswd
```

## Nginx config

Copy the example vhost and adjust:

- TLS certificate paths
- OmniStream upstream (`192.168.1.167:3000` is shown)
- Whether `/api/status` stays public

Example config:

- [omnistream.winkys.com.conf.example](omnistream.winkys.com.conf.example)

## Notes

- Put OmniStream behind HTTPS so credentials aren’t sent in cleartext.
- This protects **both the UI and APIs** (since they share the same origin).
- Later, you can replace this with Authelia/Authentik without changing OmniStream.
