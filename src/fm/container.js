import path from 'node:path';
import { ValidationError } from '../validate.js';
import { dockerRequest, dockerStream, execRun, DockerError } from '../docker.js';
import { FirstFileExtractor, singleFileTar } from '../tar.js';

/**
 * File manager driver for the filesystem INSIDE a running container.
 * Listing and changes run ls/stat/mkdir/mv/cp/rm in the container (minimal images without them get an
 * explanatory error); reading/writing/copying whole trees uses Docker's archive (tar) API.
 * Commands are always argv arrays - user supplied paths are never put in a shell string.
 */
const isDirMode = (mode) => Math.floor(mode / 2147483648) % 2 === 1; // Go os.ModeDir = 1<<31

export function cpath(p) {
  const s = String(p ?? '/');
  if (s.includes('\0') || s.length > 4096) throw new ValidationError('Invalid path');
  const n = path.posix.normalize(s.startsWith('/') ? s : '/' + s);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}
const vname = (name) => {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || /[/\0]/.test(n) || Buffer.byteLength(n) > 255) throw new ValidationError('Invalid name');
  return n;
};
const refuseRoot = (p) => { if (p === '/') throw new ValidationError('Refusing to touch the container root'); };

// perms links uid gid size|major,minor  Mon DD HH:MM|YYYY  name
const LS_RE = /^(\S+)\s+\d+\s+(\S+)\s+(\S+)\s+(\d+|\d+,\s*\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s(.*)$/;
export function parseLs(out) {
  const entries = [];
  for (const line of out.split('\n')) {
    const m = LS_RE.exec(line);
    if (!m) continue; // "total N" and blank lines
    const kind = m[1][0];
    let name = m[6], target = null;
    if (kind === 'l') { const i = name.indexOf(' -> '); if (i >= 0) { target = name.slice(i + 4); name = name.slice(0, i); } }
    if (kind === 'd') name = name.replace(/\/$/, '');
    if (name === '.' || name === '..') continue;
    entries.push({
      name, type: kind === 'd' ? 'dir' : kind === '-' ? 'file' : kind === 'l' ? 'link' : 'special',
      symlink: kind === 'l', target, size: kind === '-' ? Number(m[4]) : null,
      mtime: null, birth: null, mode: m[1].slice(0, 10), owner: `${m[2]}:${m[3]}`, mtimeText: m[5].replace(/\s+/g, ' '),
    });
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  return entries;
}

// exact times: ls only has minute resolution and no creation time. Positional arg => the dir is never shell-interpolated.
const STAT_SCRIPT = 'cd "$1" 2>/dev/null || exit 0; stat -c "%n|%W|%Y|%a|%u|%g" -- * .[!.]* ..?* 2>/dev/null';
// %W (creation time) is a number on GNU stat but a literal "W" on BusyBox - accept both, unknown => null
const STAT_RE = /^([\s\S]*)\|(-?\d+|[A-Za-z?]+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/;
export function parseStat(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = STAT_RE.exec(line); if (!m) continue;
    const birth = Number(m[2]);
    map.set(m[1], { mtime: Number(m[3]) * 1000, birth: birth > 0 ? birth * 1000 : null });
  }
  return map;
}

export function containerDriver(info) {
  const id = info.id;

  async function run(cmd) {
    const r = await execRun(id, cmd);
    if (r.exitCode === 126 || r.exitCode === 127 || /executable file not found|OCI runtime exec failed/i.test(r.stderr + r.stdout)) {
      throw new ValidationError(`The container has no "${cmd[0]}" command (minimal/distroless image). Download and upload still work for known paths.`);
    }
    return r;
  }
  const must = async (cmd, fallback) => {
    const r = await run(cmd);
    if (r.exitCode !== 0) throw new ValidationError((r.stderr || fallback).trim().split('\n')[0] || fallback);
    return r;
  };

  /** Docker's HEAD /archive returns file info base64-JSON in a header. */
  async function statPath(p) {
    const { headers } = await dockerRequest('HEAD', `/containers/${id}/archive?path=${encodeURIComponent(p)}`);
    const raw = headers['x-docker-container-path-stat'];
    if (!raw) throw new ValidationError('Not found');
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  const missing = (e) => e instanceof DockerError && e.status === 404;
  const stat = (p) => statPath(p).catch((e) => { throw missing(e) ? new ValidationError('Not found') : e; });
  async function metaOf(p) { // uid/gid/mode of an existing file, best effort (to keep them when overwriting)
    try {
      const r = await execRun(id, ['stat', '-c', '%a|%u|%g', '--', p]);
      const m = /^(\d+)\|(\d+)\|(\d+)/.exec(r.stdout.trim());
      return r.exitCode === 0 && m ? { mode: parseInt(m[1], 8), uid: Number(m[2]), gid: Number(m[3]) } : null;
    } catch { return null; }
  }

  return {
    kind: 'container', id: `container:${id}`, label: info.name, writable: true,
    assertWritable() {},

    async list(p) {
      const dir = cpath(p);
      const target = dir === '/' ? '/' : dir + '/';
      const [ls, st] = await Promise.all([
        run(['ls', '-lAnp', '--', target]),
        execRun(id, ['sh', '-c', STAT_SCRIPT, 'sh', dir]).catch(() => null), // enrichment is optional (no sh/stat -> ls data only)
      ]);
      if (ls.exitCode !== 0) throw new ValidationError((ls.stderr || 'Cannot list directory').trim().split('\n')[0]);
      const times = st ? parseStat(st.stdout) : new Map();
      const entries = parseLs(ls.stdout).map((e) => ({ ...e, ...(times.get(e.name) || {}) }));
      return { path: dir, entries };
    },

    async exists(p) { try { await statPath(cpath(p)); return true; } catch (e) { if (missing(e)) return false; throw e; } },
    async isDir(p) { return isDirMode((await stat(cpath(p))).mode); },
    async stat(p) { const s = await stat(cpath(p)); return { isDir: isDirMode(s.mode), size: s.size, mtime: Date.parse(s.mtime) || null }; },

    async readStream(p) {
      let q = cpath(p), s = await stat(q);
      for (let i = 0; s.linkTarget && !isDirMode(s.mode) && i < 5; i++) { // archive API returns the link itself: follow it
        q = path.posix.resolve(path.posix.dirname(q), s.linkTarget); s = await stat(q);
      }
      if (isDirMode(s.mode)) throw new ValidationError('Not a file');
      const src = await dockerStream('GET', `/containers/${id}/archive?path=${encodeURIComponent(q)}`);
      const ext = new FirstFileExtractor();
      src.on('error', (e) => ext.destroy(e));
      ext.on('close', () => src.destroy());
      src.pipe(ext);
      return { stream: ext, size: s.size, name: path.posix.basename(q), mtime: Date.parse(s.mtime) || null };
    },

    async writeStream(dir, name, readable, { size, overwrite = false } = {}) {
      const d = cpath(dir), n = vname(name);
      if (!Number.isFinite(size)) throw new ValidationError('Size must be known for uploads into containers');
      const target = path.posix.join(d, n);
      const exists = await this.exists(target);
      if (exists && !overwrite) throw new ValidationError('File already exists');
      const meta = exists ? await metaOf(target) : null; // keep owner/permissions when overwriting
      await dockerStream('PUT', `/containers/${id}/archive?path=${encodeURIComponent(d)}`, {
        body: singleFileTar(n, size, readable, meta || undefined), headers: { 'Content-Type': 'application/x-tar' },
      });
      return { size };
    },

    async mkdir(dir, name, { existOk = false } = {}) {
      const t = path.posix.join(cpath(dir), vname(name));
      await must(existOk ? ['mkdir', '-p', '--', t] : ['mkdir', '--', t], 'mkdir failed');
    },
    async rename(p, newName) {
      const src = cpath(p); refuseRoot(src);
      const dst = path.posix.join(path.posix.dirname(src), vname(newName));
      if (await this.exists(dst)) throw new ValidationError('Target already exists');
      await must(['mv', '--', src, dst], 'rename failed');
    },
    async remove(p) { const t = cpath(p); refuseRoot(t); await must(['rm', '-rf', '--', t], 'delete failed'); },
    async copyNative(src, dstDir) { const s = cpath(src); refuseRoot(s); await must(['cp', '-a', '--', s, path.posix.join(cpath(dstDir), path.posix.basename(s))], 'copy failed'); },
    async moveNative(src, dstDir) { const s = cpath(src); refuseRoot(s); await must(['mv', '--', s, path.posix.join(cpath(dstDir), path.posix.basename(s))], 'move failed'); },

    async tarOut(p) { return dockerStream('GET', `/containers/${id}/archive?path=${encodeURIComponent(cpath(p))}`); },
    async tarIn(dir, readable) {
      await dockerStream('PUT', `/containers/${id}/archive?path=${encodeURIComponent(cpath(dir))}`, {
        body: readable, headers: { 'Content-Type': 'application/x-tar' },
      });
      return {};
    },
  };
}
