import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { DockerError } from '../docker.js';
import { ValidationError } from '../validate.js';
import { getRoot, validName } from '../files.js';
import { tarPack, extractTar } from '../tar.js';
import { zipLocal, unzipLocal } from '../zip.js';
import { hostDriver, MAX_EXTRACT } from './host.js';
import { containerDriver, cpath } from './container.js';

/**
 * Unified file manager: a "source" is either a mounted host folder ("host:<slug>") or the inside of a
 * container ("container:<id>"). Both implement the same driver interface (see host.js / container.js), so
 * every feature - list, edit, upload, copy/move, zip/unzip - works on either one and between them.
 */
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function getDriver(spec) {
  const s = String(spec || '');
  if (s.startsWith('host:')) return hostDriver(getRoot(s.slice(5)));
  if (s.startsWith('container:')) {
    const id = s.slice(10);
    if (!ID_RE.test(id)) throw new ValidationError('Invalid container id');
    return containerDriver({ id, name: id });
  }
  throw new ValidationError('Unknown source');
}

const posix = path.posix;
const norm = (p) => { const n = posix.normalize('/' + String(p ?? '/').replace(/\0/g, '').replace(/^\/+/, '')); return n.length > 1 ? n.replace(/\/+$/, '') : n; };
export const pathList = (v) => {
  if (!Array.isArray(v) || !v.length || v.length > 1000) throw new ValidationError('Select 1-1000 items');
  return v.map((p) => { const n = norm(p); if (n === '/') throw new ValidationError('Cannot use the root folder'); return n; });
};

function tmpDir() {
  const base = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'fm-'));
}
export const cleanTmp = () => fs.rmSync(path.join(config.dataDir, 'tmp'), { recursive: true, force: true });
// archive problems (exists, zip slip, too big, corrupt) are the user's to fix: report them as 400, not 500
const userError = (e) => (e instanceof ValidationError || e instanceof DockerError ? e : new ValidationError(e.message));
const guard = async (fn) => { try { return await fn(); } catch (e) { throw userError(e); } };
const withTmp = async (fn) => { const t = tmpDir(); try { return await fn(t); } finally { fs.rmSync(t, { recursive: true, force: true }); } };

// ------------------------------------------------------------------ copy / move (also across sources)

export async function transfer({ mode, from, paths, to, toDir }) {
  if (!['copy', 'move'].includes(mode)) throw new ValidationError('mode must be copy or move');
  const a = getDriver(from), b = getDriver(to), dir = norm(toDir);
  b.assertWritable();
  if (mode === 'move') a.assertWritable();
  const done = [];
  for (const p of pathList(paths)) {
    const base = posix.basename(p);
    if (await b.exists(posix.join(dir, base))) throw new ValidationError(`"${base}" already exists in the destination`);
    if (a.id === b.id && (dir === p || dir.startsWith(p + '/'))) throw new ValidationError(`Cannot put "${base}" inside itself`);

    if (a.kind === 'host' && b.kind === 'host') { // plain filesystem operations
      const src = a.localPath(p), dst = b.leafPath(dir, base);
      if (dst === src || dst.startsWith(src + path.sep)) throw new ValidationError(`Cannot put "${base}" inside itself`);
      if (mode === 'copy') fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      else {
        try { fs.renameSync(src, dst); }
        catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true }); fs.rmSync(src, { recursive: true }); }
      }
    } else if (a.id === b.id) { // same container: native cp/mv
      await (mode === 'copy' ? a.copyNative(p, dir) : a.moveNative(p, dir));
    } else { // across sources (host <-> container, container <-> container): stream a tar between them
      await guard(async () => b.tarIn(dir, await a.tarOut(p)));
      if (mode === 'move') await a.remove(p);
    }
    done.push(base);
  }
  return { done };
}

// ------------------------------------------------------------------ zip / unzip

/** Zip the selected paths into <destDir>/<name>.zip (works for host folders and containers). */
export async function zipPaths({ src, paths, destDir, name }) {
  const d = getDriver(src); d.assertWritable();
  let n = validName(name); if (!/\.zip$/i.test(n)) n += '.zip';
  const dir = norm(destDir);
  if (await d.exists(posix.join(dir, n))) throw new ValidationError(`"${n}" already exists`);
  return withTmp(async (tmp) => {
    const entries = [];
    let i = 0;
    for (const p of pathList(paths)) {
      const base = posix.basename(p);
      if (d.kind === 'host') entries.push({ abs: d.localPath(p), name: base });
      else { // container: pull a copy to the panel's temp area first
        const dst = path.join(tmp, 'src', String(i++));
        await guard(async () => extractTar(await d.tarOut(p), dst, { maxBytes: MAX_EXTRACT }));
        entries.push({ abs: path.join(dst, base), name: base });
      }
    }
    const out = path.join(tmp, 'out.zip');
    await zipLocal(entries, out);
    const size = fs.statSync(out).size;
    await d.writeStream(dir, n, fs.createReadStream(out), { size });
    return { name: n, size };
  });
}

/** Extract a zip file. `folder` extracts into a new folder named after the zip, otherwise into `destDir`. */
export async function unzipPath({ src, path: zipPath, destDir, folder = false, overwrite = false }) {
  const d = getDriver(src); d.assertWritable();
  const zp = norm(zipPath);
  const dir = destDir ? norm(destDir) : posix.dirname(zp);
  const folderName = folder ? validName(posix.basename(zp).replace(/\.zip$/i, '') || 'extracted') : null;
  const limits = { overwrite, maxBytes: MAX_EXTRACT };

  if (d.kind === 'host') {
    const zipAbs = d.localDir(zp); // sandbox-checked real path of the zip file
    let target = d.localDir(dir);
    if (folderName) {
      target = d.leafPath(dir, folderName);
      if (fs.existsSync(target) && !overwrite) throw new ValidationError(`Folder "${folderName}" already exists`);
    }
    return guard(() => unzipLocal(zipAbs, target, limits));
  }
  return withTmp(async (tmp) => { // container: stage the zip, extract locally, push the result back as a tar
    const { stream } = await d.readStream(zp);
    const zipFile = path.join(tmp, 'in.zip');
    await pipeline(stream, fs.createWriteStream(zipFile));
    const out = path.join(tmp, 'out');
    const root = folderName ? path.join(out, folderName) : out;
    const summary = await guard(() => unzipLocal(zipFile, root, limits));
    if (!overwrite) {
      for (const top of fs.readdirSync(out)) {
        if (await d.exists(posix.join(dir, top))) throw new ValidationError(`"${top}" already exists in the destination`);
      }
    }
    const entries = fs.readdirSync(out).map((top) => ({ abs: path.join(out, top), name: top }));
    if (entries.length) await d.tarIn(dir, tarPack(entries));
    return summary;
  });
}

// ------------------------------------------------------------------ text view / edit

export const MAX_TEXT = 2 * 1024 * 1024;

/** Read a small text file. Returns {binary:true} for binary content, throws if too large. */
export async function readText(d, p) {
  const { stream, size, mtime } = await d.readStream(p);
  if (size > MAX_TEXT) { stream.destroy(); throw new ValidationError('File is larger than 2 MB - download it instead'); }
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size };
  try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), size: buf.length, mtime }; }
  catch { return { binary: true, size }; } // not valid UTF-8
}

export const writeText = (d, p, text) => {
  const n = norm(p);
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length > MAX_TEXT) throw new ValidationError('Text is larger than 2 MB');
  return d.writeStream(posix.dirname(n), posix.basename(n), Readable.from([buf]), { size: buf.length, overwrite: true });
};

export { norm, cpath };
