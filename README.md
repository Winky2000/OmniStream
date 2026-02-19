
# OmniStream

OmniStream is a dashboard to monitor multiple Plex, Jellyfin, and Emby servers on one screen. It shows active sessions, direct play vs transcoding, bandwidth usage, history, reports, and basic notifications.

## Quick start

- **Docker compose (recommended)**

	```bash
	# On your host
	mkdir -p /home/youruser/omnistream
	printf "[]\n" > /home/youruser/omnistream/servers.json

	# Optionally point SERVERS_PATH at your host file
	export SERVERS_PATH=/home/youruser/omnistream/servers.json

	# From the project root (where docker-compose.yml lives):
	docker compose up -d
	```

- **Local development (Node.js)**

	```bash
	npm install
	printf "[]\n" > servers.json
	node server.js
	```

## Features

- Monitor multiple media servers (Plex, Jellyfin, Emby)
- Per-server status (online/offline, latency)
- Live sessions with posters, media details, and progress
- Direct Play vs Transcoding highlighting
- History and basic reports
- Admin UI to add/edit/enable/disable servers
- Simple notifications (offline servers, WAN transcodes, high bandwidth)

---
## Screenshots

### Setup

![Setup welcome screen](screenshots/Setup.png)

### Dashboard

![Dashboard sessions view](screenshots/Dashboard.png)
![Dashboard alternative layout](screenshots/Dashboard2.png)

### Servers

![Servers overview](screenshots/Connected Servers.png)

### Notifiers

![Notifier configuration](screenshots/Notifiers.png)

### Themes

![Theme selector](screenshots/Themes.png)


## Running with Docker (recommended)

The published image is:

- `ghcr.io/winky2000/omnistream:latest`

### 1. Create a config directory and servers.json on the host

```bash
mkdir -p /home/youruser/omnistream
printf "[]\n" > /home/youruser/omnistream/servers.json
```

> Important: `servers.json` on the host must be a **regular file**, not a directory. Docker will create a directory if the file does not exist when you first mount it.

### 2. Run with docker-compose

The root `docker-compose.yml` is already wired to the published image and supports an overridable path for `servers.json` via `SERVERS_PATH`:

```yaml
services:
	omnistream:
		image: ghcr.io/winky2000/omnistream:latest
		container_name: omnistream
		restart: unless-stopped
		ports:
			- "3000:3000"
		environment:
			- NODE_ENV=production
		volumes:
			- ${SERVERS_PATH:-./servers.json}:/usr/src/app/servers.json
			# Optional: override bundled UI with local files
			# - ./public:/usr/src/app/public:ro
```

From the project root:

```bash
# Optionally point SERVERS_PATH at your host file
export SERVERS_PATH=/home/youruser/omnistream/servers.json

docker compose up -d
```

Then open:

- http://localhost:3000

### 3. Run with plain docker

```bash
mkdir -p /home/youruser/omnistream
printf "[]\n" > /home/youruser/omnistream/servers.json

docker run -d \
	--name omnistream \
	-p 3000:3000 \
	-v /home/youruser/omnistream/servers.json:/usr/src/app/servers.json \
	-e NODE_ENV=production \
	ghcr.io/winky2000/omnistream:latest
```

---

## First-time setup

1. Start the container.
2. Open http://localhost:3000.
3. You will see a welcome card if no servers are configured.
4. Click **Start Setup (Servers)** or go to the **Admin → Servers** tab.
5. Add your servers:
	 - **Name**: Friendly name.
	 - **Base URL**:
		 - Plex: e.g. `http://192.168.1.138:32400`
		 - Jellyfin: e.g. `http://192.168.1.138:8096`
		 - Emby: your Emby URL + port.
	 - **Type**: `plex`, `jellyfin`, or `emby`.
	 - **Token**:
		 - Plex: X-Plex token.
		 - Jellyfin/Emby: API key from the server dashboard.

OmniStream writes your server changes back to `servers.json` inside the container. With a bind mount, that updates the host file as well.

---

## Local development (Node.js)

If you want to run directly with Node instead of Docker:

1. Install dependencies:

```bash
npm install
```

2. Create a `servers.json` in the project root:

```bash
printf "[]\n" > servers.json
```

3. Start the server:

```bash
node server.js
```

Open http://localhost:3000 and add servers via the Admin UI.

---

## Running on unRAID

An example unRAID Docker template is provided at:

- `unraid/omnistream.xml`

### Template overview

- **Repository**: `ghcr.io/winky2000/omnistream:latest`
- **Network type**: `bridge`
- **WebUI**: `http://[IP]:[PORT:3000]/`
- **Port**:
	- Container port `3000` mapped to a host port (defaults to `3000`).
- **Volume**:
	- Host path: `/mnt/user/appdata/omnistream/servers.json`
	- Container path: `/usr/src/app/servers.json`
	- Mode: `rw`
	- Description: `Path to servers.json on the array/cache. The file is created/updated by OmniStream.`
- **Environment**:
	- `NODE_ENV=production`

### Importing the template

1. Copy `unraid/omnistream.xml` from this repo to your unRAID box under:

	- `/boot/config/plugins/dockerMan/templates-user/`

2. In the unRAID web UI, go to **Docker → Add Container**.
3. In the **Template** drop-down, choose **OmniStream**.
4. Adjust if needed:
	- Host port for the WebUI (if `3000` is already in use).
	- Host path for `servers.json` if you prefer a different appdata location.
5. Apply to create and start the container, then open the WebUI.

---

## Server config format

Each server entry uses this shape (fields with defaults are optional):

```json
{
	"id": "plex-1",
	"name": "Gold Tower",
	"type": "plex",        // "plex" | "jellyfin" | "emby"
	"baseUrl": "http://192.168.1.138:32400",
	"token": "...",
	"enabled": true
}
```

Optional fields (normally filled in by the app):

- `tokenLocation` — defaults to `query` for Plex, `header` for Jellyfin/Emby.
- `apiPath` — defaults to `/status/sessions` (Plex) or `/Sessions` (Jellyfin/Emby).

You can edit servers via the Admin → Servers UI rather than hand-editing `servers.json`.

---

## Troubleshooting

- **EISDIR: illegal operation on a directory, open '/usr/src/app/servers.json'**
	- The host path in your volume mapping points to a **directory** named `servers.json`.
	- Fix by deleting that directory, recreating a file with `[]`, and restarting the container.

- **Permission denied writing servers.json**
	- Ensure the host file is writable by the Docker user, e.g.:
		- `chown youruser:youruser /home/youruser/omnistream/servers.json`
		- `chmod 664 /home/youruser/omnistream/servers.json`

- **Jellyfin shows offline / 401**
	- Confirm `baseUrl` and port are correct (e.g. `http://192.168.1.138:8096`).
	- Use a valid API key; OmniStream sends it using the expected Jellyfin headers/query.

Once servers are online, the main dashboard shows live sessions, and the Admin tabs (Servers, Reports, Notifications, History) provide management and insights.

---

## TODO / ideas

- **Reports**
	- Per-user weekly/monthly watch time.
	- Per-server bandwidth trend charts.
- **Notifications**
	- More granular rules (per-user, per-library, per-location).
	- Built-in templates for Discord/email messages.
- **UI/UX**
	- Optional compact/mobile layout.
	- Icon-based client badges for popular players.
- **Technical**
	- More tests around history import and notifiers.
	- Configurable polling interval and history retention.

