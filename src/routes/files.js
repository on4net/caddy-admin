import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { audit } from '../db.js';
import { requireAdmin } from '../auth.js';
import { ValidationError } from '../validate.js';
import { fileRoots, getRoot, safePath, assertWritable, validName, listDir, safeEntry } from '../files.js';

export const files = Router();
files.use(requireAdmin);

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const rel = (req) => String(req.query.path ?? req.body?.path ?? '');

files.get('/roots', (req, res) => {
  res.json(fileRoots().map((r) => ({ slug: r.slug, name: r.name, writable: r.writable, available: fs.existsSync(r.dir) })));
});

files.get('/list', (req, res) => {
  res.json(listDir(getRoot(String(req.query.root)), rel(req)));
});

files.get('/download', (req, res, next) => {
  const root = getRoot(String(req.query.root));
  const { abs } = safePath(root, rel(req));
  if (!fs.statSync(abs).isFile()) throw new ValidationError('Not a file');
  audit(req.user.id, 'file_download', `${root.slug}:${rel(req)}`);
  res.download(abs, path.basename(abs), { dotfiles: 'allow' }, (e) => { if (e && !res.headersSent) next(e); });
});

// Raw streaming upload: PUT /upload?root=&path=<dir>&name=<file>[&overwrite=1]  (body = file bytes)
files.put('/upload', async (req, res) => {
  const root = getRoot(String(req.query.root));
  assertWritable(root);
  const name = validName(req.query.name);
  const dir = safePath(root, rel(req));
  if (!fs.statSync(dir.abs).isDirectory()) throw new ValidationError('Target is not a directory');
  const dest = safePath(root, path.relative(dir.base, path.join(dir.abs, name)), { mustExist: false });
  if (fs.existsSync(dest.abs) && req.query.overwrite !== '1') throw new ValidationError('File already exists');
  const tmp = path.join(dir.abs, `.${name}.${crypto.randomBytes(4).toString('hex')}.part`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _e, cb) { size += chunk.length; size > MAX_UPLOAD ? cb(new ValidationError('File too large')) : cb(null, chunk); },
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(tmp, { flags: 'wx' }));
    fs.renameSync(tmp, dest.abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  audit(req.user.id, 'file_upload', `${root.slug}:${rel(req)}/${name} (${size}B)`);
  res.status(201).json({ ok: true, size });
});

files.post('/mkdir', (req, res) => {
  const root = getRoot(String(req.body.root));
  assertWritable(root);
  const name = validName(req.body.name);
  const dir = safePath(root, rel(req));
  const dest = safePath(root, path.relative(dir.base, path.join(dir.abs, name)), { mustExist: false });
  if (fs.existsSync(dest.abs)) throw new ValidationError('Already exists');
  fs.mkdirSync(dest.abs);
  audit(req.user.id, 'file_mkdir', `${root.slug}:${rel(req)}/${name}`);
  res.status(201).json({ ok: true });
});

files.post('/rename', (req, res) => {
  const root = getRoot(String(req.body.root));
  assertWritable(root);
  const src = safeEntry(root, rel(req));
  if (src.abs === src.base) throw new ValidationError('Cannot rename the folder root');
  const dest = path.join(path.dirname(src.abs), validName(req.body.newName));
  if (fs.existsSync(dest)) throw new ValidationError('Target already exists');
  fs.renameSync(src.abs, dest);
  audit(req.user.id, 'file_rename', `${root.slug}:${rel(req)} -> ${req.body.newName}`);
  res.json({ ok: true });
});

files.delete('/', (req, res) => {
  const root = getRoot(String(req.query.root));
  assertWritable(root);
  const { base, abs } = safeEntry(root, rel(req));
  if (abs === base) throw new ValidationError('Cannot delete the folder root');
  fs.rmSync(abs, { recursive: true });
  audit(req.user.id, 'file_delete', `${root.slug}:${rel(req)}`);
  res.json({ ok: true });
});
