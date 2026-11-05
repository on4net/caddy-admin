import path from 'node:path';
import fs from 'node:fs';

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8181),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  // Caddy Admin API (default Caddy listens on localhost:2019)
  caddyAdmin: process.env.CADDY_ADMIN_URL || 'http://127.0.0.1:2019',
  // Host/port of Caddy's HTTPS listener as seen from the panel (service name 'caddy' in docker compose)
  caddyHost: process.env.CADDY_HOST || '127.0.0.1',
  // HTTPS port Caddy serves on (used for SSL status probing)
  caddyHttpsPort: Number(process.env.CADDY_HTTPS_PORT || 443),
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  secureCookie: process.env.SECURE_COOKIE === '1',
};
fs.mkdirSync(config.dataDir, { recursive: true });
