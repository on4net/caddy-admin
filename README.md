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
docker compose logs panel | grep -A3 "First run"   # admin password (or set ADMIN_EMAIL/ADMIN_PASSWORD in .env)
```

`.env` controls which host IP/ports Caddy binds to (`CADDY_BIND_IP`, `CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT`), the panel's bind (`PANEL_BIND_IP`, `PANEL_PORT`), the first admin and `SECURE_COOKIE`. Caddy's Admin API is always enabled (the panel needs it; the `caddy` container is only "healthy" while it answers, and the dashboard shows its status) but is never published to the host.

- `caddy`: the official `caddy:2-alpine` image, publishing 80/443. It is configured **only** through its Admin API by the panel (`docker/caddy-bootstrap.json` just sets the admin listener).
- `panel`: this app, published on `127.0.0.1:8181` only. To reach it remotely add a proxy host (e.g. `panel.example.com` -> `caddy-admin:8181`, Let's Encrypt), then set `SECURE_COOKIE=1`.
- The Admin API (2019, unauthenticated) is **not published**; it lives on the `admin` network which is `internal: true` and shared only by caddy + panel.
- To proxy other containers, attach them to the external-facing `proxy` network and use their service/container name as *Forward host*. For services on the Docker host use `host.docker.internal`.
- Volumes: `panel_data` (SQLite), `caddy_data` (issued certs + ACME account - keep it to avoid Let's Encrypt rate limits), `caddy_config` (autosave used by `--resume`: Caddy comes back with the last pushed config after a restart).
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

Containers (start / stop / restart / remove, logs, details, live CPU+memory, **run new container** with ports/env/volumes/restart policy/network, pulls the image if missing), images (pull, remove, prune unused), volumes and networks. Talks to the Docker Engine API through the mounted socket (`DOCKER_SOCK_PATH` in `.env`).

> **Security:** access to `docker.sock` is root-equivalent on the host. That is why Docker, Files and Users are admin-only, every change is written to the audit log, the panel refuses to stop/remove its own container, and the panel should only be reachable over HTTPS (proxy host) or locally. The panel container runs as root with `pid: host` for this reason (docker socket, writing to mounted folders, host network counters).

## Monitoring

CPU, memory, network throughput (↓/↑ per second + totals, per interface) and disk used/free, refreshed every 3 s with a ~6 min in-memory history (resets on panel restart). Network counters are the **host's** (`pid: host` + `/proc/1/net/dev`; virtual interfaces such as `veth*`/`docker0`/`br-*` are excluded). Disks: `MONITOR_DISKS` in `.env` (default `/|System`) plus every mounted file folder.

## File manager (admin only)

Browse, upload (streamed, size limit `MAX_UPLOAD_MB`, default 512), download, create folder, rename, delete - inside folders you mount from `.env`:

```
MOUNT_1_PATH=/srv/data        # host folder (absolute path); empty = slot unused
MOUNT_1_NAME=Data             # label (default: folder name)
MOUNT_1_MODE=rw               # rw | ro (default ro)
```

Up to **8** folders (`MOUNT_1_*` ... `MOUNT_8_*`); apply with `docker compose up -d`. Each folder is a sandbox: `..` traversal and symlinks pointing outside are rejected, deleting/renaming a symlink acts on the link itself, read-only folders reject every change, and the folder root itself cannot be deleted. Running without Docker: `FILE_ROOTS="slug|Name|rw|/path,slug2|Name2|ro|/other"`.

## Run without Docker

```bash
npm install
npm start          # http://127.0.0.1:8181
```

First start prints the admin email/password (set `ADMIN_EMAIL` / `ADMIN_PASSWORD` to choose them).
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
| Custom | Upload cert+key PEM (validated: key matches, not expired, covers the host's domains) |

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
