import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Encrypts small secrets (registry passwords) before they go into the SQLite file, AES-256-GCM.
 * The key lives in DATA_DIR/secret.key (created on first use, mode 0600). This protects against a leaked
 * database file / backup of the DB alone; anyone who can read the whole data folder can read both - keep it private.
 */
const keyFile = () => path.join(config.dataDir, 'secret.key');

function key() {
  try { const k = fs.readFileSync(keyFile()); if (k.length === 32) return k; } catch { /* create below */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(keyFile(), k, { mode: 0o600 });
  return k;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
