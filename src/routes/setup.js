import { Router } from 'express';
import crypto from 'node:crypto';
import { db, setSetting, audit, transaction } from '../db.js';
import { needsSetup, hashPassword, createSession, setSessionCookie, safeEqual } from '../auth.js';
import { applyConfig, CaddyError } from '../caddy.js';
import { parseEmail, parsePassword, ValidationError } from '../validate.js';
import { savePanelDomain } from './settings.js';

/**
 * First-run setup: the person installing chooses the admin account (and optionally the panel domain).
 * Anyone who can reach an unconfigured panel could otherwise claim it, so the form needs the setup token
 * printed in the server log (or fixed with SETUP_TOKEN). Works only while there are zero users.
 */
const setupToken = process.env.SETUP_TOKEN || crypto.randomBytes(12).toString('base64url');
export const getSetupToken = () => setupToken;

export const setup = Router();
setup.get('/status', (req, res) => res.json({ needsSetup: needsSetup() }));

const failures = new Map();
setup.post('/', async (req, res) => {
  if (!needsSetup()) return res.status(409).json({ error: 'Setup already completed' });
  const recent = (failures.get(req.ip) || []).filter((t) => Date.now() - t < 600_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many attempts, try again later' });
  if (!safeEqual(String(req.body?.token || ''), setupToken)) {
    failures.set(req.ip, [...recent, Date.now()]);
    return res.status(403).json({ error: 'Wrong setup token (see the panel log: docker compose logs panel)' });
  }
  const b = req.body;
  const email = parseEmail(b.email);
  const password = parsePassword(b.password);
  const hash = await hashPassword(password);
  const wantsDomain = String(b.panel_domain || '').trim() !== '';

  let userId;
  await transaction(async () => {
    if (!needsSetup()) throw new ValidationError('Setup already completed'); // lost a race
    userId = Number(db.prepare("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'admin')")
      .run(email, String(b.name || '').trim() || 'Administrator', hash).lastInsertRowid);
    if (wantsDomain) {
      savePanelDomain({ domain: b.panel_domain, ssl_mode: b.ssl_mode, force_ssl: b.force_ssl, hsts: b.hsts }); // validation failure rolls back everything
      if ((b.ssl_mode ?? 'letsencrypt') === 'letsencrypt') setSetting('acme_email', email); // Let's Encrypt expiry notices
    }
    audit(userId, 'setup', wantsDomain ? `admin ${email}, panel domain ${b.panel_domain}` : `admin ${email}`);
  });

  let applied, warning;
  if (wantsDomain) {
    applied = true;
    try { await applyConfig(); } catch (e) { if (!(e instanceof CaddyError)) throw e; applied = false; warning = e.message; }
  }
  setSessionCookie(res, createSession(userId), req);
  res.status(201).json({ user: { id: userId, email, name: b.name || 'Administrator', role: 'admin' }, applied, warning });
});
