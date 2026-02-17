# OmniStream

OmniStream — simple dashboard to monitor multiple Plex, Jellyfin, and Emby servers on one screen.

## What this is
- A lightweight Node.js app that polls configured servers and exposes `/api/status`.
- A tiny web UI in `public/index.html` that shows online/offline, latency, and basic info.

## Quick start

1. Copy the example config:

```powershell
copy servers.json.example servers.json
```

2. Edit `servers.json` and fill in `baseUrl` and `token` values for your servers.

3. Install and run:

```bash
npm install
npm start
```

4. Open `http://localhost:3000` in your browser.

## Server config
Each server entry supports:
- `id` (string)
- `name` (display name)
- `type` ("plex"|"jellyfin"|"emby"|"generic")
- `baseUrl` (example: `http://192.168.1.50:32400`)
- `token` (optional)
- `tokenLocation` ("header" or "query")
- `apiPath` (optional override for the path to poll)

## Notes
- The poller uses a best-effort approach: it attempts common status endpoints. You can customize `apiPath` per server.
- If you want a Dockerfile or systemd unit, tell me and I can add one.
 
## Docker

### Local build

Build and run locally:

```bash
docker build -t omnistream:latest .
docker run --rm -p 3000:3000 -v $(pwd)/servers.json:/usr/src/app/servers.json omnistream:latest
```

Or using `docker-compose`:

```bash
docker-compose up --build -d
```

The UI will be available at `http://localhost:3000`.

### Remote pull from GHCR

On a remote machine (after pushing to GitHub), use `docker-compose.remote.yml` to pull the pre-built image:

1. Download or copy `docker-compose.remote.yml` (or create a `servers.json` in the working folder).
2. Edit `docker-compose.remote.yml` and replace `YOUR_USER` with your GitHub username.
3. Run:

```bash
docker-compose -f docker-compose.remote.yml up -d
```

This will pull `ghcr.io/YOUR_USER/omnistream:latest` and start the container. No build needed.

## Publish to GitHub & pull image remotely

You can push this repo to GitHub and let GitHub Actions build and publish a Docker image to GitHub Container Registry (GHCR). The included workflow will run on pushes to `main` and publish `ghcr.io/OWNER/omnistream:latest`.

Steps:

1. Create the GitHub repo (example using `gh` CLI):

```bash
gh repo create YOUR_USER/omnistream --public --source=. --remote=origin --push
```

Or create a repository on github.com and then run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_USER/omnistream.git
git push -u origin main
```

2. After pushing, Actions will build and publish to GHCR. To pull on a remote machine (public repo / public package):

```bash
docker pull ghcr.io/YOUR_USER/omnistream:latest
docker run --rm -p 3000:3000 ghcr.io/YOUR_USER/omnistream:latest
```

If the package is private, authenticate on the remote machine:

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_USER --password-stdin
```

Notes:
- Replace `YOUR_USER` with your GitHub account or organization name.
- If you prefer Docker Hub, I can add a workflow to push there instead (requires Docker Hub credentials in repo secrets).

