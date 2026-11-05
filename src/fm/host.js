import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError } from '../validate.js';
import { safePath, safeEntry, assertWritable, validName, listDir } from '../files.js';
import { tarPack, extractTar } from '../tar.js';

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
export const MAX_EXTRACT = Number(process.env.MAX_EXTRACT_MB || 4096) * 1024 * 1024;

/**
 * File manager driver for a mounted host folder ("root", see files.js). All paths are POSIX style and
 * relative to the root ("/" = the root itself); every path goes through the sandbox checks in files.js.
 */
export function hostDriver(root) {
  const entry = (p) => safeEntry(root, p).abs;      // does not follow a symlink at the leaf (delete/rename/zip/tar)
  const real = (p) => safePath(root, p).abs;         // follows it (read/list)
  const leaf = (dir, name) => safePath(root, path.posix.join(dir, validName(name)), { mustExist: false }).abs;

  return {
    kind: 'host', id: `host:${root.slug}`, label: root.name, writable: root.writable,
    assertWritable: () => assertWritable(root),

    async list(p) { return listDir(root, p); },
    async exists(p) { try { fs.lstatSync(safePath(root, p, { mustExist: false }).abs); return true; } catch { return false; } },
    async isDir(p) { return fs.statSync(real(p)).isDirectory(); },
    async stat(p) { const s = fs.statSync(real(p)); return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs }; },
    localPath: (p) => entry(p),                 // no-follow (zip/copy/move source)
    localDir: (p) => real(p),                  // existing directory
    leafPath: (dir, name) => leaf(dir, name),  // validated destination path for a not-yet-existing name

    async readStream(p) {
      const abs = real(p); const st = fs.statSync(abs);
      if (!st.isFile()) throw new ValidationError('Not a file');
      return { stream: fs.createReadStream(abs), size: st.size, name: path.basename(abs), mtime: st.mtimeMs };
    },

    async writeStream(dir, name, readable, { overwrite = false } = {}) {
      this.assertWritable();
      const d = real(dir); if (!fs.statSync(d).isDirectory()) throw new ValidationError('Target is not a directory');
      const dest = leaf(dir, name);
      const existing = fs.lstatSync(dest, { throwIfNoEntry: false });
      if (existing && !overwrite) throw new ValidationError('File already exists');
      if (existing?.isDirectory()) throw new ValidationError('A folder with that name exists');
      const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${crypto.randomBytes(4).toString('hex')}.part`);
      let size = 0;
      const limit = new Transform({ transform(c, _e, cb) { size += c.length; cb(size > MAX_UPLOAD ? new ValidationError('File too large') : null, c); } });
      try {
        await pipeline(readable, limit, fs.createWriteStream(tmp, { flags: 'wx' }));
        if (existing?.isFile()) { try { fs.chmodSync(tmp, existing.mode & 0o7777); } catch { /* keep default */ } } // editing keeps permissions
        fs.renameSync(tmp, dest);
      } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      return { size };
    },

    async mkdir(dir, name, { existOk = false } = {}) {
      this.assertWritable();
      const dest = leaf(dir, name);
      if (fs.existsSync(dest)) { if (existOk && fs.statSync(dest).isDirectory()) return; throw new ValidationError('Already exists'); }
      fs.mkdirSync(dest);
    },

    async rename(p, newName) {
      this.assertWritable();
      const { base, abs } = safeEntry(root, p);
      if (abs === base) throw new ValidationError('Cannot rename the folder root');
      const dest = path.join(path.dirname(abs), validName(newName));
      if (fs.existsSync(dest)) throw new ValidationError('Target already exists');
      fs.renameSync(abs, dest);
    },

    async remove(p) {
      this.assertWritable();
      const { base, abs } = safeEntry(root, p);
      if (abs === base) throw new ValidationError('Cannot delete the folder root');
      fs.rmSync(abs, { recursive: true });
    },

    // tar of one entry rooted at its own name (same contract as Docker's archive API)
    async tarOut(p) { const abs = entry(p); return tarPack([{ abs, name: path.basename(abs) }]); },
    async tarIn(dir, readable, { overwrite = false } = {}) {
      this.assertWritable();
      const d = real(dir); if (!fs.statSync(d).isDirectory()) throw new ValidationError('Target is not a directory');
      return extractTar(readable, d, { overwrite, maxBytes: MAX_EXTRACT });
    },
  };
}
