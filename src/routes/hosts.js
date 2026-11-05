import { Router } from 'express';
import { db, audit, transaction } from '../db.js';
import { applyConfig, CaddyError } from '../caddy.js';
import { parseProxyHost, ValidationError } from '../validate.js';
import { coversDomain, checkSsl } from '../certs.js';
import { getSetting } from '../db.js';

export const hosts = Router();

const out = (r) => ({ ...r, domains: JSON.parse(r.domains) });
const COLS = ['domains', 'forward_scheme', 'forward_host', 'forward_port', 'ssl_mode', 'certificate_id',
  'force_ssl', 'hsts', 'skip_upstream_verify', 'enabled'];

/**
 * Mutate DB then push to Caddy in one transaction:
 *  - Caddy rejects the config  -> DB rolled back, 422 returned
 *  - Caddy unreachable         -> DB change kept, response flagged applied:false (re-synced on next start/sync)
 */
export async function mutateAndApply(fn) {
  let applied = true, warning;
  const result = await transaction(async () => {
    const r = fn();
    try { await applyConfig(); } catch (e) {
      if (e instanceof CaddyError && e.unreachable) { applied = false; warning = e.message; } else throw e;
    }
    return r;
  });
  return { result, applied, warning };
}

function checkConflicts(domains, exceptId) {
  const pd = getSetting('panel_domain');
  if (pd && domains.includes(pd)) throw new ValidationError(`Domain ${pd} is used by the panel itself (Settings -> Panel domain)`);
  const rows = db.prepare('SELECT id, domains FROM proxy_hosts WHERE id != ?').all(exceptId ?? -1);
  for (const r of rows) for (const d of JSON.parse(r.domains)) {
    if (domains.includes(d)) throw new ValidationError(`Domain ${d} is already used by host #${r.id}`);
  }
}
function checkCert(v) {
  if (v.ssl_mode !== 'custom') return;
  const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(v.certificate_id);
  if (!c) throw new ValidationError('Certificate not found');
  const cdoms = JSON.parse(c.domains);
  for (const d of JSON.parse(v.domains)) {
    if (!cdoms.some((cd) => coversDomain(cd, d))) throw new ValidationError(`Certificate "${c.name}" does not cover ${d}`);
  }
}

hosts.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM proxy_hosts ORDER BY id').all().map(out));
});

async function createHost(v, user) {
  checkConflicts(JSON.parse(v.domains));
  checkCert(v);
  const { result, applied, warning } = await mutateAndApply(() => {
    const id = db.prepare(`INSERT INTO proxy_hosts(${COLS.join(',')}) VALUES(${COLS.map(() => '?').join(',')})`)
      .run(...COLS.map((c) => v[c])).lastInsertRowid;
    audit(user.id, 'host_create', v.domains);
    return Number(id);
  });
  return { host: out(db.prepare('SELECT * FROM proxy_hosts WHERE id=?').get(result)), applied, warning };
}

async function updateHost(id, v, user) {
  checkConflicts(JSON.parse(v.domains), id);
  checkCert(v);
  const { applied, warning } = await mutateAndApply(() => {
    db.prepare(`UPDATE proxy_hosts SET ${COLS.map((c) => `${c}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`)
      .run(...COLS.map((c) => v[c]), id);
    audit(user.id, 'host_update', `#${id} ${v.domains}`);
  });
  return { host: out(db.prepare('SELECT * FROM proxy_hosts WHERE id=?').get(id)), applied, warning };
}

hosts.post('/', async (req, res) => {
  const { host, applied, warning } = await createHost(parseProxyHost(req.body), req.user);
  res.status(201).json({ ...host, applied, warning });
});

// Idempotent create-or-update keyed by domain - made for CI/scripts that run on every deploy:
//   PUT /api/hosts/by-domain/app.example.com  { forward_host, forward_port, ssl_mode:"letsencrypt", force_ssl:true }
// Fields you omit keep their current value on update; `domains` defaults to [<domain>].
hosts.put('/by-domain/:domain', async (req, res) => {
  const domain = String(req.params.domain).toLowerCase();
  const existing = db.prepare('SELECT * FROM proxy_hosts').all().find((r) => JSON.parse(r.domains).includes(domain));
  if (existing) {
    const cur = out(existing);
    const v = parseProxyHost({ ...cur, enabled: !!cur.enabled, ...req.body, domains: req.body.domains ?? cur.domains });
    const { host, applied, warning } = await updateHost(existing.id, v, req.user);
    return res.json({ ...host, created: false, applied, warning });
  }
  const v = parseProxyHost({ ...req.body, domains: req.body.domains ?? [domain] });
  const { host, applied, warning } = await createHost(v, req.user);
  res.status(201).json({ ...host, created: true, applied, warning });
});

hosts.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM proxy_hosts WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const { host, applied, warning } = await updateHost(id, parseProxyHost(req.body), req.user);
  res.json({ ...host, applied, warning });
});

hosts.post('/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM proxy_hosts WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const { applied, warning } = await mutateAndApply(() => {
    db.prepare("UPDATE proxy_hosts SET enabled = 1 - enabled, updated_at=datetime('now') WHERE id=?").run(id);
    audit(req.user.id, 'host_toggle', `#${id}`);
  });
  res.json({ ...out(db.prepare('SELECT * FROM proxy_hosts WHERE id=?').get(id)), applied, warning });
});

hosts.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM proxy_hosts WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const { applied, warning } = await mutateAndApply(() => {
    db.prepare('DELETE FROM proxy_hosts WHERE id=?').run(id);
    audit(req.user.id, 'host_delete', `#${id}`);
  });
  res.json({ ok: true, applied, warning });
});

// Live SSL status: which certificate is Caddy actually serving for this host?
// ?wait=<seconds> (max 180) polls until every domain has a usable certificate, so CI can block until
// Let's Encrypt issuance finished: `ready:true` means all domains answered with a valid certificate
// (and, for letsencrypt mode, one that is not Caddy's internal fallback CA).
hosts.get('/:id/ssl-status', async (req, res) => {
  const h = db.prepare('SELECT * FROM proxy_hosts WHERE id=?').get(Number(req.params.id));
  if (!h) return res.status(404).json({ error: 'Not found' });
  if (h.ssl_mode === 'none') return res.json({ ssl_mode: 'none', ready: true, domains: [] });
  res.json(await checkSsl(JSON.parse(h.domains), h.ssl_mode, parseInt(req.query.wait, 10) || 0));
});
