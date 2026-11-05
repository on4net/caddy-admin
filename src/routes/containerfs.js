import { Router } from 'express';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { audit } from '../db.js';
import { ValidationError } from '../validate.js';
import { dockerRequest, dockerStream, execRun, DockerError } from '../docker.js';
import { FirstFileExtractor, singleFileTar } from '../tar.js';

/**
 * File manager for the filesystem INSIDE a container (admin only, mounted under
 * /api/docker/containers/:id/fs). Listing and changes run commands in the container (ls/mkdir/mv/rm: the
 * container needs those tools and must be running); download/upload use Docker's archive API.
 */
export const cfs = Router({ mergeParams: true });

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const cid = (req) => { if (!ID_RE.test(req.params.id)) throw new ValidationError('Invalid container id'); return req.params.id; };

/** Absolute, normalised POSIX path with no NULs. */
function cpath(p) {
  const s = String(p ?? '/');
  if (s.includes('\0') || s.length > 4096) throw new ValidationError('Invalid path');
  const n = path.posix.normalize(s.startsWith('/') ? s : '/' + s);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}
const validName = (name) => {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || /[/\0]/.test(n) || Buffer.byteLength(n) > 100) throw new ValidationError('Invalid name (max 100 bytes, no slash)');
  return n;
};
const refuseRoot = (p) => { if (p === '/') throw new ValidationError('Refusing to touch the container root'); };
const isDirMode = (mode) => Math.floor(mode / 2147483648) % 2 === 1; // Go os.ModeDir = 1<<31

/** Docker's HEAD /archive returns file info base64-JSON in a header. */
async function statPath(id, p) {
  const { headers } = await dockerRequest('HEAD', `/containers/${id}/archive?path=${encodeURIComponent(p)}`);
  const raw = headers['x-docker-container-path-stat'];
  if (!raw) throw new ValidationError('Not found');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}
const exists = (id, p) => statPath(id, p).then(() => true, (e) => { if (e instanceof DockerError && e.status === 404) return false; throw e; });

const LS_RE = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+|\d+,\s*\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s(.*)$/;
export function parseLs(out) {
  const entries = [];
  for (const line of out.split('\n')) {
    const m = LS_RE.exec(line);
    if (!m) continue; // "total N" and blank lines
    const kind = m[1];
    let name = m[4], target = null;
    if (kind === 'l') { const i = name.indexOf(' -> '); if (i >= 0) { target = name.slice(i + 4); name = name.slice(0, i); } }
    if (kind === 'd') name = name.replace(/\/$/, '');
    if (name === '.' || name === '..') continue;
    entries.push({
      name, type: kind === 'd' ? 'dir' : kind === '-' ? 'file' : kind === 'l' ? 'link' : 'special',
      symlink: kind === 'l', target, size: kind === '-' ? Number(m[2]) : null, mtime: m[3].replace(/\s+/g, ' '),
    });
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  return entries;
}

async function run(id, cmd) {
  const r = await execRun(id, cmd);
  if (r.exitCode === 126 || r.exitCode === 127 || /executable file not found|no such file or directory.*(ls|mkdir|rm|mv)/i.test(r.stderr + r.stdout)) {
    throw new ValidationError(`The container has no "${cmd[0]}" command (minimal/distroless image). Download and upload still work for known paths.`);
  }
  return r;
}

cfs.get('/list', async (req, res) => {
  const id = cid(req), dir = cpath(req.query.path);
  const r = await run(id, ['ls', '-lAnp', '--', dir === '/' ? '/' : dir + '/']);
  if (r.exitCode !== 0) throw new ValidationError((r.stderr || 'Cannot list directory').trim().split('\n')[0]);
  res.json({ path: dir, entries: parseLs(r.stdout) });
});

cfs.get('/download', async (req, res) => {
  const id = cid(req);
  let p = cpath(req.query.path), stat;
  try {
    stat = await statPath(id, p);
    for (let i = 0; stat.linkTarget && !isDirMode(stat.mode) && i < 5; i++) { // follow symlinks (archive API returns the link itself)
      p = path.posix.resolve(path.posix.dirname(p), stat.linkTarget); stat = await statPath(id, p);
    }
  } catch (e) { if (e instanceof DockerError && e.status === 404) throw new ValidationError('Not found'); throw e; }
  const src = await dockerStream('GET', `/containers/${id}/archive?path=${encodeURIComponent(p)}`);
  const base = path.posix.basename(p) || 'root';
  const disposition = (n) => `attachment; filename="${n.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
  audit(req.user.id, 'container_download', `${id}:${p}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  if (isDirMode(stat.mode)) { // a folder downloads as a .tar
    res.setHeader('Content-Disposition', disposition(base + '.tar'));
    return pipeline(src, res).catch(() => {});
  }
  res.setHeader('Content-Disposition', disposition(base));
  res.setHeader('Content-Length', String(stat.size));
  const ext = new FirstFileExtractor();
  await pipeline(src, ext, res).catch(() => {});
});

// Raw upload: PUT /upload?path=<dir>&name=<file>[&overwrite=1]  body = file bytes (Content-Length required)
cfs.put('/upload', async (req, res) => {
  const id = cid(req), dir = cpath(req.query.path), name = validName(req.query.name);
  const size = Number(req.headers['content-length']);
  if (!Number.isFinite(size)) return res.status(411).json({ error: 'Content-Length required' });
  if (size > MAX_UPLOAD) throw new ValidationError('File too large');
  const target = path.posix.join(dir, name);
  if (req.query.overwrite !== '1' && await exists(id, target)) throw new ValidationError('File already exists');
  await dockerStream('PUT', `/containers/${id}/archive?path=${encodeURIComponent(dir)}`, {
    body: singleFileTar(name, size, req), headers: { 'Content-Type': 'application/x-tar' },
  }); // files are created as root:root 0644
  audit(req.user.id, 'container_upload', `${id}:${target} (${size}B)`);
  res.status(201).json({ ok: true, size });
});

cfs.post('/mkdir', async (req, res) => {
  const id = cid(req), target = path.posix.join(cpath(req.body.path), validName(req.body.name));
  const r = await run(id, ['mkdir', '--', target]);
  if (r.exitCode !== 0) throw new ValidationError((r.stderr || 'mkdir failed').trim().split('\n')[0]);
  audit(req.user.id, 'container_mkdir', `${id}:${target}`);
  res.status(201).json({ ok: true });
});

cfs.post('/rename', async (req, res) => {
  const id = cid(req), src = cpath(req.body.path);
  refuseRoot(src);
  const dst = path.posix.join(path.posix.dirname(src), validName(req.body.newName));
  if (await exists(id, dst)) throw new ValidationError('Target already exists');
  const r = await run(id, ['mv', '--', src, dst]);
  if (r.exitCode !== 0) throw new ValidationError((r.stderr || 'rename failed').trim().split('\n')[0]);
  audit(req.user.id, 'container_rename', `${id}:${src} -> ${dst}`);
  res.json({ ok: true });
});

cfs.delete('/', async (req, res) => {
  const id = cid(req), target = cpath(req.query.path);
  refuseRoot(target);
  const r = await run(id, ['rm', '-rf', '--', target]);
  if (r.exitCode !== 0) throw new ValidationError((r.stderr || 'delete failed').trim().split('\n')[0]);
  audit(req.user.id, 'container_delete', `${id}:${target}`);
  res.json({ ok: true });
});
