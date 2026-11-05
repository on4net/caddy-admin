import { Router } from 'express';
import { db, audit } from '../db.js';
import { hashPassword, requireAdmin } from '../auth.js';
import { parseEmail, parsePassword, ValidationError } from '../validate.js';

export const users = Router();
users.use(requireAdmin);

const COLS = 'id,email,name,role,disabled,created_at';
const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND disabled=0").get().c;

users.get('/', (req, res) => res.json(db.prepare(`SELECT ${COLS} FROM users ORDER BY id`).all()));

users.post('/', async (req, res) => {
  const email = parseEmail(req.body.email);
  const password = parsePassword(req.body.password);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new ValidationError('Email already exists');
  const id = db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)')
    .run(email, String(req.body.name || '').trim(), await hashPassword(password), role).lastInsertRowid;
  audit(req.user.id, 'user_create', email);
  res.status(201).json(db.prepare(`SELECT ${COLS} FROM users WHERE id=?`).get(id));
});

users.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const role = req.body.role ?? u.role;
  const disabled = req.body.disabled === undefined ? u.disabled : (req.body.disabled ? 1 : 0);
  if (!['admin', 'user'].includes(role)) throw new ValidationError('Invalid role');
  const losesAdmin = u.role === 'admin' && !u.disabled && (role !== 'admin' || disabled);
  if (losesAdmin && adminCount() <= 1) throw new ValidationError('Cannot remove the last active admin');
  const hash = req.body.password ? await hashPassword(parsePassword(req.body.password)) : u.password_hash;
  db.prepare('UPDATE users SET name=?, role=?, disabled=?, password_hash=? WHERE id=?')
    .run(req.body.name ?? u.name, role, disabled, hash, id);
  if (disabled || req.body.password) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(req.user.id, 'user_update', u.email);
  res.json(db.prepare(`SELECT ${COLS} FROM users WHERE id=?`).get(id));
});

users.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) throw new ValidationError('You cannot delete yourself');
  if (u.role === 'admin' && !u.disabled && adminCount() <= 1) throw new ValidationError('Cannot remove the last active admin');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit(req.user.id, 'user_delete', u.email);
  res.json({ ok: true });
});
