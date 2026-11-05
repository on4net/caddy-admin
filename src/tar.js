import { Readable, Transform } from 'node:stream';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createSink } from './sink.js';

/**
 * Tar support (no dependencies) for Docker's /containers/:id/archive endpoints and for copying folders
 * between host and containers: pack local paths -> tar stream, extract a tar stream -> local folder (safely),
 * single-file helpers. Handles ustar, GNU long names (L/K) and PAX headers (x).
 */
const BLOCK = 512;
const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK;
const octal = (n, len) => Math.max(0, Math.floor(n)).toString(8).padStart(len - 1, '0').slice(-(len - 1)) + '\0';

function makeHeader({ name, size = 0, type = '0', mode = 0o644, uid = 0, gid = 0, mtime = Math.floor(Date.now() / 1000), linkname = '' }) {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100); b.write(octal(uid, 8), 108); b.write(octal(gid, 8), 116);
  b.write(octal(size, 12), 124); b.write(octal(mtime, 12), 136);
  b.write('        ', 148); // checksum placeholder = 8 spaces
  b.write(type, 156);
  if (linkname) b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\0', 257); b.write('00', 263);
  let sum = 0; for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

/** ustar header for one regular file (kept for uploads). */
export function fileHeader(name, size, opts = {}) {
  if (Buffer.byteLength(name) > 100) throw new Error('File name too long (max 100 bytes)');
  return makeHeader({ name, size, ...opts });
}

/** Tar stream holding one file whose bytes come from `readable` (size must be known up front). */
export function singleFileTar(name, size, readable, opts) {
  return Readable.from((async function* () {
    if (Buffer.byteLength(name) > 100) { // GNU long name extension entry
      const data = Buffer.from(name + String.fromCharCode(0));
      yield makeHeader({ name: '././@LongLink', size: data.length, type: 'L' });
      yield data; if (pad(data.length)) yield Buffer.alloc(pad(data.length));
    }
    yield makeHeader({ name, size, ...opts });
    let sent = 0;
    for await (const chunk of readable) { sent += chunk.length; yield chunk; }
    if (sent !== size) throw new Error('Upload size mismatch');
    if (pad(size)) yield Buffer.alloc(pad(size));
    yield Buffer.alloc(BLOCK * 2); // end-of-archive marker
  })());
}

// ---------------------------------------------------------------- pack (local paths -> tar)

async function* entryHeaders(name, st, type, linkname = '') {
  if (Buffer.byteLength(name) > 100) { // GNU long name extension entry
    const data = Buffer.from(name + '\0');
    yield makeHeader({ name: '././@LongLink', size: data.length, type: 'L' });
    yield data; if (pad(data.length)) yield Buffer.alloc(pad(data.length));
  }
  yield makeHeader({
    name, size: type === '0' ? st.size : 0, type, linkname,
    mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, mtime: Math.floor(st.mtimeMs / 1000),
  });
}

async function* packPath(abs, name) {
  const st = await fsp.lstat(abs);
  if (st.isDirectory()) {
    yield* entryHeaders(name + '/', st, '5');
    for (const child of await fsp.readdir(abs)) yield* packPath(path.join(abs, child), `${name}/${child}`);
  } else if (st.isSymbolicLink()) {
    const target = await fsp.readlink(abs);
    if (Buffer.byteLength(target) <= 100) yield* entryHeaders(name, st, '2', target);
  } else if (st.isFile()) {
    yield* entryHeaders(name, st, '0');
    let sent = 0;
    if (st.size > 0) {
      for await (const chunk of fs.createReadStream(abs, { start: 0, end: st.size - 1 })) { sent += chunk.length; yield chunk; }
    }
    if (sent < st.size) yield Buffer.alloc(st.size - sent); // file shrank while reading
    if (pad(st.size)) yield Buffer.alloc(pad(st.size));
  } // sockets, devices, fifos: skipped
}

/** entries: [{abs, name}] - each becomes a root of the archive (a folder is included recursively). */
export function tarPack(entries) {
  return Readable.from((async function* () {
    for (const e of entries) yield* packPath(e.abs, e.name);
    yield Buffer.alloc(BLOCK * 2);
  })());
}

// ---------------------------------------------------------------- extract (tar -> local folder)

class ByteReader {
  constructor(readable) { this.it = readable[Symbol.asyncIterator](); this.buf = Buffer.alloc(0); this.done = false; }
  async fill(n) {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) { this.done = true; break; }
      this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    }
  }
  async read(n) { await this.fill(n); const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(out.length); return out; }
  async skip(n) {
    while (n > 0) {
      if (!this.buf.length) { await this.fill(1); if (!this.buf.length) throw new Error('Unexpected end of archive'); }
      const k = Math.min(n, this.buf.length); this.buf = this.buf.subarray(k); n -= k;
    }
  }
  async pipeTo(ws, n) {
    while (n > 0) {
      if (!this.buf.length) { await this.fill(1); if (!this.buf.length) throw new Error('Unexpected end of archive'); }
      const take = this.buf.subarray(0, Math.min(n, this.buf.length)); this.buf = this.buf.subarray(take.length); n -= take.length;
      if (!ws.write(take)) await once(ws, 'drain');
    }
  }
}

function parseHeader(b) {
  if (b.every((x) => x === 0)) return null;
  const str = (o, l) => b.toString('utf8', o, o + l).replace(/\0[\s\S]*$/, '');
  const num = (o, l) => {
    if (b[o] & 0x80) { let v = 0; for (let i = o + 1; i < o + l; i++) v = v * 256 + b[i]; return v; } // base-256
    return parseInt(str(o, l).trim() || '0', 8);
  };
  let name = str(0, 100);
  if (str(257, 5) === 'ustar' && str(345, 155)) name = `${str(345, 155)}/${name}`;
  return { name, mode: num(100, 8), size: num(124, 12), mtime: num(136, 12), type: String.fromCharCode(b[156] || 48), linkname: str(157, 100) };
}

function parsePax(buf) { // "<len> key=value\n" records
  const out = {}; let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i); if (sp < 0) break;
    const len = parseInt(buf.toString('utf8', i, sp), 10); if (!len) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('='); if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Extract a tar stream into `destAbs`. Safe against path traversal and symlink escapes (see sink.js),
 * refuses to overwrite unless asked, caps total size/entries (tar bombs). Hard links/devices/fifos are skipped.
 */
export async function extractTar(readable, destAbs, { overwrite = false, maxBytes = Infinity, maxEntries = 500_000 } = {}) {
  const sink = await createSink(destAbs);
  const r = new ByteReader(readable);
  const summary = { files: 0, dirs: 0, bytes: 0, skipped: [] };
  let pax = {}, longName = null, longLink = null, entries = 0;
  const dirTimes = [];
  for (;;) {
    const hb = await r.read(BLOCK);
    if (hb.length < BLOCK) break;
    const h = parseHeader(hb);
    if (!h) break;
    if (h.type === 'x') { pax = parsePax(await r.read(h.size)); await r.skip(pad(h.size)); continue; }
    if (h.type === 'g') { await r.skip(h.size + pad(h.size)); continue; }
    if (h.type === 'L') { longName = (await r.read(h.size)).toString('utf8').replace(/\0[\s\S]*$/, ''); await r.skip(pad(h.size)); continue; }
    if (h.type === 'K') { longLink = (await r.read(h.size)).toString('utf8').replace(/\0[\s\S]*$/, ''); await r.skip(pad(h.size)); continue; }
    const name = pax.path ?? longName ?? h.name;
    const link = pax.linkpath ?? longLink ?? h.linkname;
    const size = pax.size != null ? Number(pax.size) : h.size;
    pax = {}; longName = null; longLink = null;
    if (++entries > maxEntries) throw new Error('Archive has too many entries');
    const skipData = async () => r.skip(size + pad(size));

    if (h.type === '5') {
      const abs = await sink.dirTarget(name); if (abs) { await fsp.mkdir(abs, { recursive: true, mode: 0o755 }); summary.dirs++; dirTimes.push([abs, h.mtime, h.mode]); }
      else summary.skipped.push(name);
      await skipData();
    } else if (h.type === '0' || h.type === '\0' || h.type === '7') {
      summary.bytes += size;
      if (summary.bytes > maxBytes) throw new Error('Extracted data exceeds the size limit');
      const abs = await sink.fileTarget(name, { overwrite });
      if (!abs) { summary.skipped.push(name); await skipData(); continue; }
      const ws = fs.createWriteStream(abs, { flags: overwrite ? 'w' : 'wx' });
      const closed = once(ws, 'close'); const failed = new Promise((_, rej) => ws.once('error', rej));
      await Promise.race([(async () => { await r.pipeTo(ws, size); ws.end(); await closed; })(), failed]);
      await r.skip(pad(size));
      await fsp.chmod(abs, (h.mode & 0o7777) || 0o644).catch(() => {});
      await fsp.utimes(abs, h.mtime, h.mtime).catch(() => {});
      summary.files++;
    } else if (h.type === '2') {
      const abs = await sink.symlinkTarget(name, link, { overwrite });
      if (abs) await fsp.symlink(link, abs); else summary.skipped.push(name);
      await skipData();
    } else { summary.skipped.push(name); await skipData(); }
  }
  for (const [abs, mtime, mode] of dirTimes.reverse()) { // after contents are written
    await fsp.utimes(abs, mtime, mtime).catch(() => {});
    await fsp.chmod(abs, ((mode & 0o7777) || 0o755) | 0o700).catch(() => {});
  }
  return summary;
}

// ---------------------------------------------------------------- single-file extraction (downloads)

/**
 * Transform: tar stream in -> bytes of the FIRST regular file out. Skips PAX/GNU long-name extension entries.
 * Emits 'meta' ({name,size,type}) before the first data byte. Anything after the first file is ignored.
 */
export class FirstFileExtractor extends Transform {
  constructor() { super(); this.buf = Buffer.alloc(0); this.state = 'header'; this.remain = 0; this.meta = null; }

  _transform(chunk, _enc, cb) {
    let data = chunk;
    while (data.length && this.state !== 'done') {
      if (this.state === 'header') {
        this.buf = Buffer.concat([this.buf, data]);
        if (this.buf.length < BLOCK) { data = Buffer.alloc(0); break; }
        const h = parseHeader(this.buf.subarray(0, BLOCK));
        data = this.buf.subarray(BLOCK); this.buf = Buffer.alloc(0);
        if (!h) { this.state = 'done'; break; }
        if (['x', 'g', 'L', 'K'].includes(h.type)) { this.state = 'skip'; this.remain = Math.ceil(h.size / BLOCK) * BLOCK; }
        else if (h.type === '0' || h.type === '\0' || h.type === '7') {
          this.meta = h; this.emit('meta', h);
          this.state = h.size ? 'body' : 'done'; this.remain = h.size;
        } else { this.meta = h; this.emit('meta', h); this.state = 'done'; } // directory/symlink/device: not extractable
      } else if (this.state === 'skip') {
        const n = Math.min(this.remain, data.length); data = data.subarray(n); this.remain -= n;
        if (!this.remain) this.state = 'header';
      } else if (this.state === 'body') {
        const n = Math.min(this.remain, data.length); this.push(data.subarray(0, n)); data = data.subarray(n); this.remain -= n;
        if (!this.remain) this.state = 'done';
      }
    }
    cb();
  }
}
