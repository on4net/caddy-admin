import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import {
  authenticate, tokenGuard, bootstrapAdmin, needsSetup, login, destroySession, sessionToken,
  setSessionCookie, clearSessionCookie, hashPassword, verifyPassword,
} from './auth.js';
import { applyConfig, CaddyError } from './caddy.js';
import { ValidationError, parsePassword } from './validate.js';
import { hosts } from './routes/hosts.js';
import { certificates } from './routes/certificates.js';
import { users } from './routes/users.js';
import { settings } from './routes/settings.js';
import { systemStats, systemHistory, startSampler } from './modules/system.js';
import { docker } from './routes/docker.js';
import { files } from './routes/files.js';
import { tokens } from './routes/tokens.js';
import { setup, getSetupToken } from './routes/setup.js';
import { DockerError } from './docker.js';
import { attachTerminal } from './terminal.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // behind Caddy: trust X-Forwarded-* from private/loopback peers only (real client IP, req.secure)
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:");
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  // CSRF defence in depth (cookie is SameSite=Strict): state changes must be JSON
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.body !== undefined && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON required' });
    }
    next();
  });

  app.use('/api/setup', setup);
  app.post('/api/login', async (req, res) => {
    const r = await login(req, req.body?.email, req.body?.password);
    if (r.error) return res.status(r.status).json({ error: r.error });
    setSessionCookie(res, r.token, req);
    res.json(r.user);
  });
  app.post('/api/logout', (req, res) => {
    const t = sessionToken(req);
    if (t) destroySession(t);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(authenticate, tokenGuard); // tokenGuard confines CI API tokens to /hosts and /certificates
  api.get('/me', (req, res) => res.json(req.user));
  api.post('/me/password', async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!(await verifyPassword(String(req.body.current || ''), u.password_hash))) throw new ValidationError('Current password is wrong');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(parsePassword(req.body.password)), u.id);
    res.json({ ok: true });
  });
  api.get('/system', (req, res) => res.json(systemStats()));
  api.get('/system/history', (req, res) => res.json(systemHistory()));
  api.use('/docker', docker);
  api.use('/files', files);
  api.use('/tokens', tokens);
  api.use('/hosts', hosts);
  api.use('/certificates', certificates);
  api.use('/users', users);
  api.use('/settings', settings);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // terminal front-end libs are served from our own origin (CSP blocks CDNs)
  const vendor = { 'xterm.js': '@xterm/xterm/lib/xterm.js', 'xterm.css': '@xterm/xterm/css/xterm.css', 'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js' };
  for (const [name, file] of Object.entries(vendor)) app.get(`/vendor/${name}`, (req, res) => res.sendFile(path.join(root, 'node_modules', file)));
  app.use(express.static(path.join(root, 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof DockerError) return res.status(err.status === 304 ? 200 : err.status).json({ error: err.message });
    if (err instanceof CaddyError) return res.status(422).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const first = await bootstrapAdmin();
  if (first) console.log(`Admin account created from ADMIN_EMAIL: ${first.email}`);
  else if (needsSetup()) {
    console.log('\n=== First-time setup ===');
    console.log(`  Open the panel in your browser (http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port} unless you changed the bind address)`);
    console.log(`  and create the admin account. Setup token:  ${getSetupToken()}\n`);
  }
  if (process.env.CERT_ASK_TOKEN && process.env.CERT_ASK_TOKEN.length < 24) console.warn('CERT_ASK_TOKEN ignored: must be at least 24 characters');
  startSampler();
  const server = createApp().listen(config.port, config.host, () => console.log(`caddy-admin on http://${config.host}:${config.port}`));
  attachTerminal(server);
  // Re-sync Caddy with DB state at startup (Caddy may have restarted empty)
  // Skipped when there are no hosts, so we never wipe a pre-existing Caddy config by accident.
  if (db.prepare('SELECT COUNT(*) c FROM proxy_hosts').get().c > 0) {
    applyConfig().then(() => console.log('Caddy config synced'), (e) => console.warn('Caddy sync skipped:', e.message));
  }
}
