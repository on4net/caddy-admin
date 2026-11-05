import { Router } from 'express';
import { db, audit, getSetting } from '../db.js';
import { inspectCertificate } from '../certs.js';
import { ValidationError } from '../validate.js';

export const certificates = Router();

// never return private keys
const out = (r) => ({
  id: r.id, name: r.name, domains: JSON.parse(r.domains), expires_at: r.expires_at, created_at: r.created_at,
  daysLeft: r.expires_at ? Math.floor((new Date(r.expires_at) - Date.now()) / 86_400_000) : null,
  in_use: db.prepare('SELECT COUNT(*) c FROM proxy_hosts WHERE certificate_id=?').get(r.id).c
    + (getSetting('panel_domain') && getSetting('panel_ssl_mode') === 'custom' && Number(getSetting('panel_cert_id')) === r.id ? 1 : 0),
});

certificates.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM certificates ORDER BY id').all().map(out));
});

// Upload a custom certificate (PEM). Let's Encrypt / internal certs need no upload:
// pick them on the proxy host and Caddy issues + renews automatically.
certificates.post('/', (req, res) => {
  const { name, certificate, private_key } = req.body || {};
  if (!String(name || '').trim()) throw new ValidationError('Name is required');
  let info;
  try { info = inspectCertificate(String(certificate || ''), String(private_key || '')); }
  catch (e) { throw new ValidationError(e.message); }
  const id = db.prepare('INSERT INTO certificates(name,domains,cert_pem,key_pem,expires_at) VALUES(?,?,?,?,?)')
    .run(String(name).trim(), JSON.stringify(info.domains), certificate, private_key, info.expiresAt).lastInsertRowid;
  audit(req.user.id, 'cert_create', `${name} ${info.domains.join(',')}`);
  res.status(201).json(out(db.prepare('SELECT * FROM certificates WHERE id=?').get(id)));
});

certificates.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM certificates WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (out(row).in_use) throw new ValidationError('Certificate is used by a proxy host');
  db.prepare('DELETE FROM certificates WHERE id=?').run(id);
  audit(req.user.id, 'cert_delete', row.name);
  res.json({ ok: true });
});
