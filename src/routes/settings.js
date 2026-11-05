import { Router } from 'express';
import { db, getSetting, setSetting, audit } from '../db.js';
import { requireAdmin } from '../auth.js';
import { applyConfig, caddyStatus, CaddyError } from '../caddy.js';
import { parseEmail, parseDomains, ValidationError } from '../validate.js';
import { mutateAndApply } from './hosts.js';
import { checkSsl, coversDomain } from '../certs.js';

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

// ---------- the panel's own domain ----------
const panelState = () => {
  const domain = getSetting('panel_domain');
  return {
    domain, ssl_mode: getSetting('panel_ssl_mode', 'letsencrypt'), certificate_id: Number(getSetting('panel_cert_id')) || null,
    force_ssl: getSetting('panel_force_ssl', '1') === '1', hsts: getSetting('panel_hsts', '0') === '1',
    url: domain ? `${getSetting('panel_ssl_mode', 'letsencrypt') === 'none' ? 'http' : 'https'}://${domain}` : '',
  };
};

settings.get('/panel-domain', (req, res) => res.json(panelState()));

/** Validate + store the panel domain settings (no Caddy push). Shared with first-run setup. */
export function savePanelDomain(b) {
  const domain = parseDomains(b.domain);
  if (domain.length !== 1 || domain[0].startsWith('*.')) throw new ValidationError('Enter exactly one domain or subdomain (no wildcard)');
  const mode = b.ssl_mode ?? 'letsencrypt';
  if (!['none', 'letsencrypt', 'internal', 'custom'].includes(mode)) throw new ValidationError('Invalid ssl_mode');
  for (const r of db.prepare('SELECT id, domains FROM proxy_hosts').all()) {
    if (JSON.parse(r.domains).includes(domain[0])) throw new ValidationError(`${domain[0]} is already used by proxy host #${r.id}`);
  }
  let certId = '';
  if (mode === 'custom') {
    const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(Number(b.certificate_id));
    if (!c) throw new ValidationError('Choose a certificate');
    if (!JSON.parse(c.domains).some((cd) => coversDomain(cd, domain[0]))) throw new ValidationError(`Certificate "${c.name}" does not cover ${domain[0]}`);
    certId = c.id;
  }
  setSetting('panel_domain', domain[0]);
  setSetting('panel_ssl_mode', mode);
  setSetting('panel_cert_id', certId);
  setSetting('panel_force_ssl', mode !== 'none' && b.force_ssl !== false ? '1' : '0');
  setSetting('panel_hsts', mode !== 'none' && b.hsts ? '1' : '0');
}

settings.put('/panel-domain', requireAdmin, async (req, res) => {
  const { applied, warning } = await mutateAndApply(() => { savePanelDomain(req.body || {}); audit(req.user.id, 'panel_domain_set', req.body.domain); });
  res.json({ ...panelState(), applied, warning });
});

settings.delete('/panel-domain', requireAdmin, async (req, res) => {
  const { applied, warning } = await mutateAndApply(() => { setSetting('panel_domain', ''); audit(req.user.id, 'panel_domain_clear'); });
  res.json({ ...panelState(), applied, warning });
});

settings.get('/panel-domain/ssl-status', async (req, res) => {
  const p = panelState();
  if (!p.domain) return res.status(404).json({ error: 'No panel domain configured' });
  if (p.ssl_mode === 'none') return res.json({ ssl_mode: 'none', ready: true, domains: [] });
  res.json(await checkSsl([p.domain], p.ssl_mode, parseInt(req.query.wait, 10) || 0));
});
