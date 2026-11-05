import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'caddy-admin.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  domains TEXT NOT NULL,            -- JSON array
  cert_pem TEXT NOT NULL,
  key_pem TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS proxy_hosts (
  id INTEGER PRIMARY KEY,
  domains TEXT NOT NULL,            -- JSON array
  forward_scheme TEXT NOT NULL DEFAULT 'http' CHECK (forward_scheme IN ('http','https')),
  forward_host TEXT NOT NULL,
  forward_port INTEGER NOT NULL,
  ssl_mode TEXT NOT NULL DEFAULT 'none' CHECK (ssl_mode IN ('none','letsencrypt','internal','custom')),
  certificate_id INTEGER REFERENCES certificates(id) ON DELETE RESTRICT,
  force_ssl INTEGER NOT NULL DEFAULT 0,
  hsts INTEGER NOT NULL DEFAULT 0,
  skip_upstream_verify INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'write' CHECK (scope IN ('read','write')),
  created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const getSetting = (key, def = '') =>
  db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? def;
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

export function audit(userId, action, detail = '') {
  db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)').run(userId ?? null, action, String(detail).slice(0, 500));
}

/** Run fn inside a transaction; rolls back if fn (sync or async) throws. */
export async function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = await fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
