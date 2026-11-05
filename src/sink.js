import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Safe destination for extracting untrusted archives (tar from a container, zip uploaded by a user).
 * Guards against "zip slip": absolute names, "..", and symlinks (existing or created earlier in the same
 * archive) that would send a later write outside the destination folder.
 * Every method returns the absolute path to write, or null when the entry must be skipped.
 */
export async function createSink(destAbs) {
  await fsp.mkdir(destAbs, { recursive: true });
  const base = await fsp.realpath(destAbs);
  const inside = (p) => p === base || p.startsWith(base + path.sep);

  const clean = (name) => {
    const n = path.posix.normalize(String(name).replace(/\\/g, '/').replace(/^\/+/, ''));
    if (!n || n === '.' || n === '..' || n.startsWith('../') || n.includes('\0')) return null;
    return n.replace(/\/+$/, '');
  };

  /** Create parents and make sure the real parent directory is still inside the destination. */
  async function parentOf(rel) {
    const abs = path.join(base, rel);
    if (!inside(abs)) return null;
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const realParent = await fsp.realpath(path.dirname(abs));
    return inside(realParent) ? path.join(realParent, path.basename(abs)) : null;
  }

  return {
    base,
    async dirTarget(name) {
      const rel = clean(name); if (!rel) return null;
      const abs = await parentOf(rel); if (!abs) return null;
      const st = await fsp.lstat(abs).catch(() => null);
      return st && !st.isDirectory() ? null : abs; // never write through a symlink/file that squats the name
    },
    async fileTarget(name, { overwrite = false } = {}) {
      const rel = clean(name); if (!rel) return null;
      const abs = await parentOf(rel); if (!abs) return null;
      const st = await fsp.lstat(abs).catch(() => null);
      if (st) {
        if (!overwrite) throw new Error(`"${rel}" already exists`);
        if (st.isDirectory()) throw new Error(`"${rel}" is a folder`);
        if (st.isSymbolicLink()) await fsp.unlink(abs); // replace the link itself, never follow it
      }
      return abs;
    },
    async symlinkTarget(name, linkTarget, { overwrite = false } = {}) {
      const rel = clean(name); if (!rel || !linkTarget) return null;
      const abs = await parentOf(rel); if (!abs) return null;
      const resolved = path.resolve(path.dirname(abs), linkTarget);
      if (!inside(resolved)) return null; // link would point outside the destination
      const st = await fsp.lstat(abs).catch(() => null);
      if (st) { if (!overwrite) throw new Error(`"${rel}" already exists`); if (st.isDirectory()) return null; await fsp.unlink(abs); }
      return abs;
    },
  };
}
