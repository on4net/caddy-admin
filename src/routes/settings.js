import { Router } from 'express';
import { db, getSetting, setSetting, audit } from '../db.js';
import { requireAdmin } from '../auth.js';
import { applyConfig, caddyStatus, CaddyError } from '../caddy.js';
import { parseEmail } from '../validate.js';

export const settings = Router();

settings.get('/', (req, res) => {
  res.json({ acme_email: getSetting('acme_email'), acme_ca: getSetting('acme_ca') });
});

settings.put('/', requireAdmin, async (req, res) => {
  const email = req.body.acme_email ? parseEmail(req.body.acme_email) : '';
  const ca = String(req.body.acme_ca || '').trim();
  if (ca && !/^https:\/\//.test(ca)) return res.status(400).json({ error: 'ACME CA must be an https:// URL' });
  setSetting('acme_email', email);
  setSetting('acme_ca', ca);
  audit(req.user.id, 'settings_update');
  let applied = true, warning;
  try { await applyConfig(); } catch (e) {
    if (!(e instanceof CaddyError)) throw e;
    applied = false; warning = e.message;
  }
  res.json({ ok: true, applied, warning });
});

settings.get('/caddy', async (req, res) => res.json(await caddyStatus()));

// Re-push DB state to Caddy (e.g. after Caddy restarted with an empty config)
settings.post('/sync', requireAdmin, async (req, res) => {
  try { await applyConfig(); res.json({ ok: true }); }
  catch (e) { if (e instanceof CaddyError) return res.status(502).json({ error: e.message }); throw e; }
});

settings.get('/audit', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT a.id,a.action,a.detail,a.at,u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100`).all());
});
