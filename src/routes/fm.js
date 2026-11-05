import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { audit } from '../db.js';
import { requireAdmin } from '../auth.js';
import { ValidationError } from '../validate.js';
import { fileRoots } from '../files.js';
import { dockerJson } from '../docker.js';
import { getDriver, pathList, norm, transfer, zipPaths, unzipPath, readText, writeText, MAX_TEXT } from '../fm/index.js';

/**
 * Unified file manager API (admin only). `src` selects what to browse:
 *   host:<slug>      a folder mounted from .env (MOUNT_n_*)
 *   container:<id>   the inside of a running container
 * Same endpoints for both - see src/fm/index.js. Everything that changes anything is audited.
 */
export const fm = Router();
fm.use(requireAdmin);

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const drv = (req) => getDriver(req.query.src ?? req.body?.src);
const qpath = (req) => norm(req.query.path ?? req.body?.path ?? '/');
const note = (req, action, d, detail) => audit(req.user.id, `fm_${action}`, `${d.id}:${detail}`);
const disposition = (kind, n) => `${kind}; filename="${n.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}`;

// safe to display inline in the browser (images, pdf). Everything else is always a download.
const INLINE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf' };

fm.get('/sources', async (req, res) => {
  const out = { hosts: fileRoots().map((r) => ({ id: `host:${r.slug}`, name: r.name, writable: r.writable, available: fs.existsSync(r.dir) })), containers: [], dockerError: null };
  try {
    out.containers = (await dockerJson('GET', '/containers/json')).map((c) => ({ id: `container:${c.Id.slice(0, 12)}`, name: (c.Names[0] || '').replace(/^\//, ''), image: c.Image }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { out.dockerError = e.message; }
  res.json(out);
});

fm.get('/list', async (req, res) => {
  const d = drv(req);
  res.json({ ...(await d.list(qpath(req))), source: { id: d.id, label: d.label, writable: d.writable } });
});

fm.get('/download', async (req, res) => {
  const d = drv(req), p = qpath(req);
  if (p === '/') throw new ValidationError('Choose a file or folder');
  const base = path.posix.basename(p);
  note(req, 'download', d, p);
  if (await d.isDir(p)) { // folders download as a tar
    const tar = await d.tarOut(p);
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', disposition('attachment', base + '.tar'));
    return pipeline(tar, res).catch(() => {});
  }
  const { stream, size } = await d.readStream(p);
  const inline = req.query.inline === '1' && INLINE[path.extname(base).slice(1).toLowerCase()];
  res.setHeader('Content-Type', inline || 'application/octet-stream');
  res.setHeader('Content-Disposition', disposition(inline ? 'inline' : 'attachment', base));
  if (inline) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  if (Number.isFinite(size)) res.setHeader('Content-Length', String(size));
  await pipeline(stream, res).catch(() => {});
});

fm.get('/read', async (req, res) => {
  const d = drv(req);
  const r = await readText(d, qpath(req));
  if (r.binary) return res.status(415).json({ error: 'This looks like a binary file - download it instead', binary: true, size: r.size });
  res.json({ ...r, writable: d.writable, limit: MAX_TEXT });
});

fm.put('/write', express.text({ type: () => true, limit: MAX_TEXT }), async (req, res) => {
  const d = drv(req); d.assertWritable();
  const p = qpath(req);
  const r = await writeText(d, p, typeof req.body === 'string' ? req.body : '');
  note(req, 'edit', d, `${p} (${r.size}B)`);
  res.json({ ok: true, size: r.size });
});

// raw streaming upload: PUT /upload?src=&path=<dir>&name=<file>[&overwrite=1]  (body = file bytes)
fm.put('/upload', async (req, res) => {
  const d = drv(req); d.assertWritable();
  const size = Number(req.headers['content-length']);
  if (!Number.isFinite(size)) return res.status(411).json({ error: 'Content-Length required' });
  if (size > MAX_UPLOAD) throw new ValidationError('File too large');
  const dir = qpath(req), name = String(req.query.name || '');
  await d.writeStream(dir, name, req, { size, overwrite: req.query.overwrite === '1' });
  note(req, 'upload', d, `${path.posix.join(dir, name)} (${size}B)`);
  res.status(201).json({ ok: true, size });
});

fm.post('/mkdir', async (req, res) => {
  const d = drv(req); const dir = qpath(req);
  await d.mkdir(dir, req.body.name, { existOk: !!req.body.existOk });
  note(req, 'mkdir', d, path.posix.join(dir, String(req.body.name)));
  res.status(201).json({ ok: true });
});

fm.post('/mkfile', async (req, res) => {
  const d = drv(req); d.assertWritable();
  const dir = qpath(req);
  await d.writeStream(dir, req.body.name, Readable.from([]), { size: 0, overwrite: false });
  note(req, 'mkfile', d, path.posix.join(dir, String(req.body.name)));
  res.status(201).json({ ok: true });
});

fm.post('/rename', async (req, res) => {
  const d = drv(req), p = qpath(req);
  await d.rename(p, req.body.newName);
  note(req, 'rename', d, `${p} -> ${req.body.newName}`);
  res.json({ ok: true });
});

fm.post('/delete', async (req, res) => {
  const d = drv(req); d.assertWritable();
  const paths = pathList(req.body.paths);
  for (const p of paths) { await d.remove(p); note(req, 'delete', d, p); }
  res.json({ ok: true, deleted: paths.length });
});

// copy / move between any two folders - also host <-> container and container <-> container
fm.post('/transfer', async (req, res) => {
  const b = req.body || {};
  const r = await transfer({ mode: b.mode, from: b.from?.src, paths: b.from?.paths, to: b.to?.src, toDir: b.to?.path });
  audit(req.user.id, `fm_${b.mode}`, `${b.from.src} -> ${b.to.src}:${b.to.path} [${r.done.join(', ')}]`.slice(0, 480));
  res.json({ ok: true, ...r });
});

fm.post('/zip', async (req, res) => {
  const d = drv(req);
  const r = await zipPaths({ src: d.id, paths: req.body.paths, destDir: qpath(req), name: req.body.name });
  note(req, 'zip', d, `${r.name} (${r.size}B)`);
  res.status(201).json({ ok: true, ...r });
});

fm.post('/unzip', async (req, res) => {
  const d = drv(req);
  const r = await unzipPath({ src: d.id, path: req.body.path, destDir: req.body.dest, folder: !!req.body.folder, overwrite: !!req.body.overwrite });
  note(req, 'unzip', d, `${req.body.path} (${r.files} files)`);
  res.json({ ok: true, ...r });
});

