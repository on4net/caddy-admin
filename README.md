# Caddy Admin

A web panel for [Caddy](https://caddyserver.com), in the spirit of Nginx Proxy Manager:
proxy hosts, SSL certificates, users - plus Docker management, server monitoring and a file manager.

- **Backend:** Node.js (>= 22.13) + Express 5, built-in `node:sqlite` (no native modules)
- **Frontend:** dependency-free SPA in `public/` (no build step)
- **Caddy integration:** the SQLite DB is the source of truth. On every change the full JSON config is generated and pushed to Caddy's Admin API (`POST /config/apps`).

## Docker Compose (Caddy and panel as two services)

```bash
cp .env.example .env      # set CADDY_BIND_IP, ports, first admin, ...
docker compose up -d --build
docker compose logs panel | grep -A3 "First-time"   # setup token
```

Then open `http://127.0.0.1:8181`: the **setup page** asks for the setup token (from the log) and lets you choose the admin email/password and, optionally, the panel's domain. The token exists because whoever reaches an unconfigured panel first would otherwise own it. For unattended installs set `ADMIN_EMAIL` + `ADMIN_PASSWORD` in `.env` instead (and optionally `SETUP_TOKEN` to fix the token).

### Publishing the image (Nexus / any Docker registry)

`scripts/publish-images.sh` builds the panel image and pushes it (version + `latest`) so servers can pull it instead of building:

```bash
cp scripts/.env.example scripts/.env     # NEXUS_USERNAME, NEXUS_PASSWORD, REGISTRY (the Docker *connector* host:port), ...
./scripts/publish-images.sh              # build + push package.json's version and latest
./scripts/publish-images.sh --bump patch # as a new version (remembered in scripts/.env)
./scripts/publish-images.sh build        # build only      |  push  # push what was built   |  --no-latest, --version X.Y.Z
```

On the server set `PANEL_IMAGE=<registry>/caddy-admin:<version>` in `.env`, then `docker login <registry> && docker compose pull panel && docker compose up -d --no-build`. `CADDY_IMAGE` does the same for Caddy. Networks that cannot reach Docker Hub / npmjs can build through mirrors with `NODE_IMAGE` and `NPM_REGISTRY` in `scripts/.env`. Never commit `scripts/.env` (it holds the registry password).

### Panel on its own domain

Settings -> **Panel domain**: give the panel a domain or subdomain (DNS A/AAAA must point at the server, ports 80/443 open) with Let's Encrypt, internal CA, a custom certificate or plain HTTP, plus Force SSL / HSTS. Caddy then proxies that domain to the panel (`PANEL_UPSTREAM`, `panel:8181` in compose); "Check SSL" / "Wait for certificate" show issuance status. The local address `http://127.0.0.1:8181` keeps working regardless, so a wrong domain or failed issuance cannot lock you out. A proxy host cannot use the panel's domain and vice versa. The session cookie becomes `Secure` automatically over HTTPS, and login throttling sees the real client IP (X-Forwarded-For from Caddy).

`.env` controls which host IP/ports Caddy binds to (`CADDY_BIND_IP`, `CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT`), the panel's bind (`PANEL_BIND_IP`, `PANEL_PORT`), the first admin and `SECURE_COOKIE`. Caddy's Admin API is always enabled (the panel needs it; the `caddy` container is only "healthy" while it answers, and the dashboard shows its status) but is never published to the host.

- `caddy`: the official `caddy:2-alpine` image, publishing 80/443. It is configured **only** through its Admin API by the panel (its tiny starting config - just the admin listener - is inline in `docker-compose.yml`, so a server only needs that file and `.env`; Docker Compose >= 2.23.1).
- `panel`: this app, published on `127.0.0.1:8181` only. To reach it remotely add a proxy host (e.g. `panel.example.com` -> `caddy-admin:8181`, Let's Encrypt), then set `SECURE_COOKIE=1`.
- The Admin API (2019, unauthenticated) is **not published**; it lives on the `admin` network which is `internal: true` and shared only by caddy + panel.
- If `docker compose up` says *network proxy ... was not created by compose* / *incorrect label*, a network named `proxy` already exists on the server: set `PROXY_NETWORK_EXTERNAL=true` in `.env` to reuse it (or pick another name with `PROXY_NETWORK`). Check what is attached first: `docker network inspect proxy`.
- To proxy other containers, attach them to the external-facing `proxy` network and use their service/container name as *Forward host*. For services on the Docker host use `host.docker.internal`.
- Data lives in three **folders next to `docker-compose.yml`** (bind mounts, so you can back them up by copying): `panel_data/` (SQLite: users, hosts, uploaded certificate keys), `caddy_data/` (issued certificates, private keys + ACME account - keep it to avoid Let's Encrypt rate limits), `caddy_config/` (autosave used by `--resume`: Caddy comes back with the last pushed config after a restart). They contain **secrets** (git-ignored, never commit or publish them) and are owned by root; `docker compose down -v` does *not* delete them - remove the folders to reset.
- The panel only replaces Caddy's `apps` section (`POST /config/apps`), never `admin`, so it cannot lock itself out.

## CI / scripts: API tokens

CI can create hosts and get Let's Encrypt certificates over the API. Two kinds of bearer token (`Authorization: Bearer <token>`):

- **`CERT_ASK_TOKEN`** in `.env` (min 24 chars, `openssl rand -hex 32`): static token with write access.
- **Tokens created in the UI** (Settings -> API tokens): named, `write` or `read` scope, optional expiry, revocable, stored hashed, shown once. They are removed if their creator is deleted.

Tokens are confined to `/api/hosts` and `/api/certificates` - never Docker, files, users, settings or token management. Every token write is in the audit log.

```bash
# Idempotent: creates the host on first run, updates it on later deploys (omitted fields keep their value).
# ssl_mode=letsencrypt makes Caddy request + auto-renew the certificate.
curl -X PUT https://panel.example.com/api/hosts/by-domain/app.example.com   -H "Authorization: Bearer $CERT_ASK_TOKEN" -H "Content-Type: application/json"   -d '{"forward_host":"app","forward_port":8080,"ssl_mode":"letsencrypt","force_ssl":true,"hsts":true}'

# Block until the certificate is issued and served (up to 180 s); "ready": true when done
curl -H "Authorization: Bearer $CERT_ASK_TOKEN" "https://panel.example.com/api/hosts/<id>/ssl-status?wait=120"
```

GitHub Actions: store the token as a secret and run the two `curl` calls in a step. Other endpoints: `GET/POST/PUT/DELETE /api/hosts[/:id]`, `POST /api/hosts/:id/toggle`, `GET /api/certificates`, `POST /api/certificates` (upload PEM). Use the staging ACME CA (Settings -> ACME CA URL, `https://acme-staging-v02.api.letsencrypt.org/directory`) while testing to avoid Let's Encrypt rate limits.

## Docker management (admin only)

Containers (start / stop / restart / remove, details, live CPU+memory, **run new container** with ports/env/volumes/restart policy/network, pulls the image if missing), images (pull, remove, prune unused), volumes, networks and registry logins. Talks to the Docker Engine API through the mounted socket (`DOCKER_SOCK_PATH` in `.env`).

**Networks** - the container table shows each container's networks with their IPs. *Networks* on a container shows IP, gateway, MAC and aliases per network, lets you **connect** it to another network (optional aliases and static IPv4) or **disconnect** it. The *Networks* tab lists every network (subnet/gateway, compose stack, members with IP/MAC), creates networks (name, optional subnet/gateway, internal) and removes unused ones; built-in networks (`bridge`, `host`, `none`) are protected and Docker refuses to remove a network that still has containers. The panel refuses to disconnect **itself** (it would lose Caddy and you).

**Pull / Update** - per container: *Pull latest image* downloads the newest image for the container's tag and tells you whether it is newer; *Pull & update container* then replaces the container with one built from the same settings (ports, environment, volumes incl. anonymous ones, networks with aliases/static IPs, restart policy, labels - compose stacks keep working). Settings that merely came from the old image (env, cmd, labels) are not pinned, so the new image's defaults apply. Order: stop -> rename old aside -> create + start new -> delete old **without its volumes**; if the new container fails to start the old one is restored. The panel cannot replace its own container (pull, then `docker compose up -d`).

**Registries** - Docker tab -> *Registries*: save a login for a private registry (e.g. your Nexus). The daemon verifies it when you save; afterwards every pull of an image from that host (Images tab, Run container, container Pull/Update) uses it automatically. The password is encrypted (AES-256-GCM, key in `panel_data/secret.key`) and is only ever sent to the matching registry host, never to Docker Hub or look-alike hosts. Protect `panel_data/` - the key is next to the database.

**Finding things and keeping your place** - the container list has a search box (every word must match name, image, stack, id, port, network or IP), filters for state / stack / network, and sorting by name, state, image, stack, CPU or memory (header click or the dropdown, with a reverse button). Your search/filter/sort are remembered. Actions (start, stop, restart, remove, network, update, run) do **not** reload the page: only that row shows "working...", then just the list is re-read in place, the scroll position and your search stay, and the result appears as a small toast in the corner. Optional auto-refresh every 10 s.

For **any** container (running or stopped), straight from the Docker table:

- **Logs** - live follow (Server-Sent Events), tail size, text filter, wrap, "Download all" (streamed, any size). The browser keeps the last 5000 lines.
- **Terminal** - a real interactive shell in the browser (`docker exec` with a TTY, xterm.js over a WebSocket): colours, vim/top, resize, optional user (`root`, `1000`...), shell `auto|sh|bash`. Closing the window ends the session; idle sessions end after `EXEC_IDLE_MIN` (default 30); max 10 sessions.
- **Files** - the same file manager as for host folders (see below), pointed at the inside of a running container: *Files page -> Docker containers*, or the "Files" button in the table.

Terminal and container files are shells/filesystem access as root inside the container: admin session only (API tokens can never use them), same-origin checked against cross-site WebSocket hijacking, every session and change is audited, and commands are passed as argument arrays (no shell string built from user input).

> **Security:** access to `docker.sock` is root-equivalent on the host. That is why Docker, Files and Users are admin-only, every change is written to the audit log, the panel refuses to stop/remove its own container, and the panel should only be reachable over HTTPS (proxy host) or locally. The panel container runs as root with `pid: host` for this reason (docker socket, writing to mounted folders, host network counters).

## Monitoring

CPU, memory, network throughput (↓/↑ per second + totals, per interface) and disk used/free, refreshed every 3 s with a ~6 min in-memory history (resets on panel restart). Network counters are the **host's** (`pid: host` + `/proc/1/net/dev`; virtual interfaces such as `veth*`/`docker0`/`br-*` are excluded). Disks: `MONITOR_DISKS` in `.env` (default `/|System`) plus every mounted file folder.

## File manager (admin only)

One file manager for **two kinds of sources**: folders you mount from `.env` (the server) and the inside of any **running container**. Everything below works on both, and between them.

| Feature | Details |
|---|---|
| Listing | Name, **size**, **created**, **modified**, permissions (+ owner in containers), sortable columns. *Created* shows `-` when the filesystem does not record it (BusyBox containers, some bind mounts) |
| Create | New folder, new empty file |
| View / edit | Text files (up to 2 MB) open in an editor with Save / Ctrl+S (owner and permissions are kept); images preview inline; PDFs open in a new tab; binary files offer Download. HTML is never rendered inline |
| Upload | Files and whole **folders** (button or drag and drop), streamed with a progress bar, optional overwrite |
| Download | Files, or folders as `.tar` |
| Copy / Move | Select items -> Copy or Cut -> open any other folder, **even another source** (host <-> container, container <-> container) -> Paste. Folders keep permissions/symlinks; existing names are never overwritten; a folder cannot go into itself |
| Zip / Unzip | Zip a selection into `name.zip`; unzip "here" or "into a new folder", optional overwrite. For containers the panel does the zipping, so the container needs no `zip`/`unzip` |
| Rename / Delete | Multi-select delete with confirmation |

Mount host folders in `.env` (up to **8**: `MOUNT_1_*` ... `MOUNT_8_*`, apply with `docker compose up -d`):

```
MOUNT_1_PATH=/srv/data        # host folder (absolute path); empty = slot unused
MOUNT_1_NAME=Data             # label (default: folder name)
MOUNT_1_MODE=rw               # rw | ro (default ro)
```

Safety: every folder is a sandbox (`..` and symlinks that point outside are rejected; deleting/renaming a symlink acts on the link itself); read-only folders reject every change; roots cannot be deleted. Archives are untrusted: **zip slip** (`../`, absolute names, symlink tricks), **zip/tar bombs** (`MAX_EXTRACT_MB`, default 4096; entry-count cap) and symlink entries are handled, and extraction never overwrites unless you tick overwrite. Container operations use argument arrays (no shell strings), need the container to be running, and its `ls`/`stat`/`mkdir`/`mv`/`cp`/`rm` (minimal images get an explanatory error). Files the panel creates in a container are `root:root 0644`; edits keep the original owner and mode. Large zip/unzip jobs stage in `DATA_DIR/tmp`. API: `/api/fm/*` with `src=host:<slug>` or `src=container:<id>` (admin session only; API tokens cannot use it). Running without Docker: `FILE_ROOTS="slug|Name|rw|/path,slug2|Name2|ro|/other"`.

## Run without Docker

```bash
npm install
npm start          # http://127.0.0.1:8181
```

First start prints a setup token; open the panel and create the admin (or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`).
Caddy must be running with its admin API reachable (default `http://127.0.0.1:2019`).

| Env | Default | |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8181` | panel listen address (keep it local or behind Caddy + HTTPS) |
| `DATA_DIR` | `./data` | SQLite DB location |
| `CADDY_ADMIN_URL` | `http://127.0.0.1:2019` | Caddy Admin API |
| `CADDY_HOST` / `CADDY_HTTPS_PORT` | `127.0.0.1` / `443` | where to probe the served certificate (`caddy` in compose) |
| `SECURE_COOKIE` | off | set `1` when the panel is served over HTTPS |

## SSL (per proxy host)

| Mode | Behaviour |
|---|---|
| None | HTTP only |
| Let's Encrypt | Caddy's ACME issues + auto-renews. Set the account email in Settings. Needs DNS pointing at the server and ports 80/443 open |
| Internal CA | Caddy's local CA (LAN / testing; not publicly trusted) |
| Custom | Upload cert+key PEM (validated: key matches, not expired, covers the host's domains). Pick **Custom certificate** in the host dialog and a modal lets you paste the PEM or load the files without leaving the dialog; the new certificate is selected for you (same in Settings -> Panel domain) |

**WebSockets** (ws:// and wss://), Server-Sent Events and gRPC need no setting: Caddy proxies them automatically (unlike nginx, which needs extra headers).

Plus **Force SSL** (308 redirect HTTP→HTTPS), **HSTS**, and a live **SSL status** probe showing the certificate Caddy actually serves (issuer, expiry).

## Behaviour to know

- **Caddy rejects a config → the DB change is rolled back** and the error is shown. **Caddy unreachable → the change is kept** and flagged; use *Settings → Re-sync Caddy* (also runs at startup when hosts exist).
- The panel **owns Caddy's `apps` config**: the first push replaces any servers configured by hand (e.g. from a Caddyfile). Startup never pushes an empty config.
- Custom certificate private keys are stored in the SQLite file (never returned by the API) — protect `data/` (file permissions / disk encryption).
- Users: admin/user roles; scrypt passwords; sessions stored hashed in SQLite; login throttling; last active admin cannot be removed. Non-admins can view but not manage users/settings.

## Layout

```
src/caddy.js        config builder (pure, unit-tested) + Admin API client
src/certs.js        PEM validation, live cert probe
src/routes/*        REST API (hosts, certificates, users, settings)
src/modules/*       server-management modules (system monitoring)  <- add more here
src/docker.js       Docker Engine API client (unix socket / named pipe)
src/files.js        file manager sandbox (path + symlink safety)
public/             UI
test/               node --test (fake Caddy admin server)
```

## Roadmap ideas

Redirection/404 hosts, streams (TCP/UDP), access lists (basic auth/IP allow), custom per-host Caddy snippets, DNS-challenge/wildcard certs, Docker Compose stacks (up/down/edit), container exec/terminal, in-browser text editor for files, process list and service/log viewer, alerts (disk/CPU thresholds), persistent metrics history.
