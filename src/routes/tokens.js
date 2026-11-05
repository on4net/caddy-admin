import { Router } from 'express';
import { db, audit } from '../db.js';
import { requireAdmin, createApiToken } from '../auth.js';
import { ValidationError } from '../validate.js';

/** API tokens for CI/scripts (admin session only). The token value is shown exactly once at creation. */
export const tokens = Router();
tokens.use(requireAdmin);

tokens.get('/', (req, res) => {
  res.json({
    env_token_enabled: (process.env.CERT_ASK_TOKEN || '').length >= 24,
    tokens: db.prepare(
      `SELECT t.id,t.name,t.prefix,t.scope,t.created_at,t.expires_at,t.last_used_at,u.email AS created_by
       FROM api_tokens t LEFT JOIN users u ON u.id=t.created_by ORDER BY t.id DESC`).all(),
  });
});

tokens.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 60) throw new ValidationError('Name is required (max 60 chars)');
  const scope = req.body.scope === 'read' ? 'read' : 'write';
  let expires = null;
  if (req.body.expires_days) {
    const d = Number(req.body.expires_days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw new ValidationError('expires_days must be 1-3650');
    expires = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 19).replace('T', ' '); // sqlite datetime format
  }
  const { id, token } = createApiToken(name, scope, req.user.id, expires);
  audit(req.user.id, 'token_create', `${name} (${scope})`);
  res.status(201).json({ id, name, scope, expires_at: expires, token }); // only time the token is returned
});

tokens.delete('/:id', (req, res) => {
  const t = db.prepare('SELECT name FROM api_tokens WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM api_tokens WHERE id=?').run(Number(req.params.id));
  audit(req.user.id, 'token_revoke', t.name);
  res.json({ ok: true });
});
