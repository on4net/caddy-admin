import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { createSink } from './sink.js';

/** Create a zip at `outFile` from local paths. entries: [{abs, name}] (folders recursive; symlinks are skipped). */
export async function zipLocal(entries, outFile) {
  const zip = new yazl.ZipFile();
  const walk = async (abs, name) => {
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) {
      zip.addEmptyDirectory(name, { mtime: st.mtime, mode: st.mode });
      for (const child of await fsp.readdir(abs)) await walk(path.join(abs, child), `${name}/${child}`);
    } else if (st.isFile()) zip.addFile(abs, name, { mtime: st.mtime, mode: st.mode });
  };
  for (const e of entries) await walk(e.abs, e.name);
  const out = fs.createWriteStream(outFile);
  const done = pipeline(zip.outputStream, out);
  zip.end();
  await done;
}

/**
 * Extract a zip into destAbs. Defends against zip slip (sink.js), zip bombs (declared AND actual byte
 * counts are capped, entry count capped) and symlink entries (skipped). Existing files are never overwritten
 * unless `overwrite`. Returns {files, dirs, bytes, skipped}.
 */
export function unzipLocal(zipFile, destAbs, { overwrite = false, maxBytes = Infinity, maxEntries = 200_000 } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, async (err, zf) => {
      if (err) return reject(new Error(`Not a valid zip file (${err.message})`));
      let sink;
      try { sink = await createSink(destAbs); } catch (e) { zf.close(); return reject(e); }
      const summary = { files: 0, dirs: 0, bytes: 0, skipped: [] };
      let entries = 0, declared = 0;
      const fail = (e) => { zf.close(); reject(e); };
      zf.on('error', fail);
      zf.on('end', () => resolve(summary));
      zf.on('entry', async (entry) => {
        try {
          if (++entries > maxEntries) throw new Error('Zip has too many entries');
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0o177777;
          if (name.endsWith('/')) {
            const abs = await sink.dirTarget(name);
            if (abs) { await fsp.mkdir(abs, { recursive: true }); summary.dirs++; } else summary.skipped.push(name);
            return zf.readEntry();
          }
          if ((mode & 0o170000) === 0o120000) { summary.skipped.push(name); return zf.readEntry(); } // symlink entry
          declared += entry.uncompressedSize;
          if (declared > maxBytes) throw new Error('Zip contents exceed the size limit (possible zip bomb)');
          const abs = await sink.fileTarget(name, { overwrite });
          if (!abs) { summary.skipped.push(name); return zf.readEntry(); }
          const rs = await new Promise((res, rej) => zf.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
          let seen = 0;
          const guard = new Transform({
            transform(chunk, _e, cb) {
              seen += chunk.length; summary.bytes += chunk.length;
              cb(summary.bytes > maxBytes ? new Error('Zip contents exceed the size limit (possible zip bomb)') : null, chunk);
            },
          });
          await pipeline(rs, guard, fs.createWriteStream(abs, { flags: overwrite ? 'w' : 'wx' }));
          const perm = mode & 0o777;
          await fsp.chmod(abs, perm || 0o644).catch(() => {});
          await fsp.utimes(abs, entry.getLastModDate(), entry.getLastModDate()).catch(() => {});
          summary.files++;
          zf.readEntry();
        } catch (e) { fail(e); }
      });
      zf.readEntry();
    });
  });
}
