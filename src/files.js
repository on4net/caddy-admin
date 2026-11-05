import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './validate.js';

/**
 * File manager roots, from two sources:
 *  - docker-compose: MOUNT_1..8_PATH / _NAME / _MODE from .env (host folder bind-mounted at /mnt/files/n)
 *  - env FILE_ROOTS for non-docker use: "slug|Display name|ro|/dir,slug2|Name2|rw|/other"
 * Each root is an isolated sandbox: every path is resolved inside it, symlinks are resolved and re-checked
 * so a link cannot escape the root, and 'ro' roots reject every change.
 */
export function fileRoots() {
  const roots = (process.env.FILE_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [slug, name, mode, ...dir] = s.split('|');
    return { slug, name: name || slug, writable: mode === 'rw', dir: dir.join('|') };
  }).filter((r) => r.slug && r.dir);
  // docker-compose slots: MOUNT_n_PATH (host folder, from .env) is bind-mounted at /mnt/files/n
  for (let i = 1; i <= 8; i++) {
    const hostPath = (process.env[`MOUNT_${i}_PATH`] || '').trim();
    if (!hostPath) continue;
    const name = (process.env[`MOUNT_${i}_NAME`] || '').trim() || hostPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || `Folder ${i}`;
    roots.push({ slug: `m${i}`, name, writable: process.env[`MOUNT_${i}_MODE`] === 'rw', dir: `${process.env.MOUNT_BASE || '/mnt/files'}/${i}` });
  }
  return roots;
}

export function getRoot(slug) {
  const r = fileRoots().find((x) => x.slug === slug);
  if (!r) throw new ValidationError('Unknown folder');
  return r;
}

const inside = (base, target) => target === base || target.startsWith(base + path.sep);

/**
 * Resolve a user supplied relative path to an absolute one inside the root.
 * `mustExist=false` allows a not-yet-existing leaf (create/upload); its parent must resolve inside the root.
 */
export function safePath(root, rel = '', { mustExist = true } = {}) {
  let base;
  try { base = fs.realpathSync(root.dir); } catch { throw new ValidationError('Folder is not available (is it mounted?)'); }
  const cleaned = String(rel || '').replace(/\0/g, '');
  const target = path.resolve(base, '.' + path.sep + cleaned.replace(/^[/\\]+/, ''));
  if (!inside(base, target)) throw new ValidationError('Path escapes the folder');
  let real;
  try { real = fs.realpathSync(target); }
  catch {
    if (mustExist) throw new ValidationError('Not found');
    const parent = path.dirname(target);
    let realParent;
    try { realParent = fs.realpathSync(parent); } catch { throw new ValidationError('Parent folder does not exist'); }
    if (!inside(base, realParent)) throw new ValidationError('Path escapes the folder');
    return { base, abs: path.join(realParent, path.basename(target)) };
  }
  if (!inside(base, real)) throw new ValidationError('Path escapes the folder');
  return { base, abs: real };
}

/**
 * Like safePath but does NOT follow a symlink at the leaf: used for delete/rename so that
 * acting on a link affects the link itself, never what it points to.
 */
export function safeEntry(root, rel = '') {
  const { base, abs: parent } = safePath(root, path.dirname('/' + String(rel || '').replace(/^[/\\]+/, '')));
  const name = path.basename(String(rel || '').replace(/[/\\]+$/, ''));
  if (!name) return { base, abs: base };
  const abs = path.join(parent, validName(name));
  try { fs.lstatSync(abs); } catch { throw new ValidationError('Not found'); }
  return { base, abs };
}

export function assertWritable(root) {
  if (!root.writable) throw new ValidationError(`"${root.name}" is mounted read-only`);
}

export function validName(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n) || n.length > 255) throw new ValidationError('Invalid name');
  return n;
}

/** rwxr-xr-x style string from an fs mode */
export function modeString(mode, isDir) {
  const r = 'rwxrwxrwx'; let out = isDir ? 'd' : '-';
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? r[i] : '-';
  return out;
}

export function listDir(root, rel) {
  const { base, abs } = safePath(root, rel);
  if (!fs.statSync(abs).isDirectory()) throw new ValidationError('Not a directory');
  const entries = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, d.name);
    let st, lst;
    try { lst = fs.lstatSync(full); } catch { continue; } // vanished
    try { st = fs.statSync(full); } catch { st = null; } // broken symlink
    const isDir = !!st?.isDirectory();
    entries.push({
      name: d.name,
      type: isDir ? 'dir' : st?.isFile() ? 'file' : st ? 'special' : 'broken',
      symlink: lst.isSymbolicLink(),
      target: lst.isSymbolicLink() ? (() => { try { return fs.readlinkSync(full); } catch { return null; } })() : null,
      size: st?.isFile() ? st.size : null,
      mtime: (st || lst).mtimeMs,
      birth: (st || lst).birthtimeMs > 0 ? (st || lst).birthtimeMs : null, // null when the filesystem has no creation time
      mode: modeString((st || lst).mode, isDir),
    });
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  return { path: '/' + path.relative(base, abs).split(path.sep).filter(Boolean).join('/'), entries };
}
