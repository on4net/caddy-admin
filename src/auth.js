import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, audit } from './db.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Create first admin if the DB has no users. Returns credentials info or null. */
export async function bootstrapAdmin() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'admin')")
    .run(email, 'Administrator', await hashPassword(password));
  return { email, password, generated: !process.env.ADMIN_PASSWORD };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(sha256(token), userId, Date.now() + config.sessionHours * 3600_000);
  return token;
}
export const destroySession = (token) => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));

const parseCookies = (h = '') =>
  Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionHours * 3600}${config.secureCookie ? '; Secure' : ''}`);
}
export const clearSessionCookie = (res) =>
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');

export const sessionToken = (req) => parseCookies(req.headers.cookie).sid;

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

export function createApiToken(name, scope, userId, expiresAt) {
  const token = `cat_${crypto.randomBytes(32).toString('base64url')}`;
  const id = db.prepare('INSERT INTO api_tokens(name,token_hash,prefix,scope,created_by,expires_at) VALUES(?,?,?,?,?,?)')
    .run(name, sha256(token), token.slice(0, 8), scope, userId, expiresAt || null).lastInsertRowid;
  return { id: Number(id), token };
}

/** Bearer auth for CI/scripts. Tokens get role 'token' and are confined by tokenGuard(). */
function authenticateToken(req, res, next, presented) {
  // static token from .env (CERT_ASK_TOKEN): write access to hosts/certificates
  const envTok = process.env.CERT_ASK_TOKEN;
  if (envTok && envTok.length >= 24 && safeEqual(presented, envTok)) {
    req.user = { id: null, email: 'token:CERT_ASK_TOKEN', name: 'CERT_ASK_TOKEN', role: 'token', scope: 'write' };
    return next();
  }
  const row = db.prepare(
    `SELECT t.id,t.name,t.scope,t.created_by FROM api_tokens t JOIN users u ON u.id=t.created_by
     WHERE t.token_hash=? AND u.disabled=0 AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))`).get(sha256(presented));
  if (!row) return res.status(401).json({ error: 'Invalid or expired token' });
  db.prepare("UPDATE api_tokens SET last_used_at=datetime('now') WHERE id=?").run(row.id);
  req.user = { id: row.created_by, email: `token:${row.name}`, name: row.name, role: 'token', scope: row.scope };
  next();
}

/** Tokens may only touch /hosts and /certificates; 'read' tokens only GET. Everything else is session-only. */
export function tokenGuard(req, res, next) {
  if (req.user.role !== 'token') return next();
  if (!/^\/(hosts|certificates)(\/|$)/.test(req.path)) return res.status(403).json({ error: 'API tokens can only use /hosts and /certificates' });
  const write = !['GET', 'HEAD'].includes(req.method);
  if (write && req.user.scope !== 'write') return res.status(403).json({ error: 'Token is read-only' });
  if (write) res.on('finish', () => { if (res.statusCode < 400) audit(req.user.id, 'api_token', `${req.user.email} ${req.method} ${req.originalUrl}`); });
  next();
}

export function authenticate(req, res, next) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (bearer) return authenticateToken(req, res, next, bearer[1]);
  const token = sessionToken(req);
  const row = token && db.prepare(
    `SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(sha256(token), Date.now());
  if (!row) return res.status(401).json({ error: 'Not authenticated' });
  req.user = row;
  next();
}
export const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

// naive in-memory login throttle: 8 failures / 10 min per ip+email
const fails = new Map();
const throttleKey = (req, email) => `${req.ip}|${String(email).toLowerCase()}`;
function isThrottled(key) {
  const f = (fails.get(key) || []).filter((t) => Date.now() - t < 600_000);
  fails.set(key, f);
  return f.length >= 8;
}

export async function login(req, email, password) {
  const key = throttleKey(req, email);
  if (isThrottled(key)) return { error: 'Too many attempts, try again later', status: 429 };
  const u = db.prepare('SELECT * FROM users WHERE email=? AND disabled=0').get(String(email));
  // hash a dummy value when the user is missing to keep timing similar
  const ok = u ? await verifyPassword(String(password), u.password_hash) : (await scrypt('x', 'x', 64), false);
  if (!ok) {
    fails.set(key, [...(fails.get(key) || []), Date.now()]);
    audit(null, 'login_failed', email);
    return { error: 'Invalid email or password', status: 401 };
  }
  fails.delete(key);
  audit(u.id, 'login');
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role }, token: createSession(u.id) };
}
