import { Readable, Transform } from 'node:stream';

/** Minimal tar support for Docker's /containers/:id/archive endpoints (single regular files only). */

const BLOCK = 512;

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

/** ustar header for one regular file. */
export function fileHeader(name, size, { mode = 0o644, uid = 0, gid = 0, mtime = Math.floor(Date.now() / 1000) } = {}) {
  if (Buffer.byteLength(name) > 100) throw new Error('File name too long (max 100 bytes)');
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 'utf8');
  b.write(octal(mode, 8), 100); b.write(octal(uid, 8), 108); b.write(octal(gid, 8), 116);
  b.write(octal(size, 12), 124); b.write(octal(mtime, 12), 136);
  b.write('        ', 148); // checksum placeholder = 8 spaces
  b.write('0', 156); // regular file
  b.write('ustar\0', 257); b.write('00', 263);
  let sum = 0; for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

/** Tar stream holding one file whose bytes come from `readable` (size must be known up front). */
export function singleFileTar(name, size, readable, opts) {
  return Readable.from((async function* () {
    yield fileHeader(name, size, opts);
    let sent = 0;
    for await (const chunk of readable) { sent += chunk.length; yield chunk; }
    if (sent !== size) throw new Error('Upload size mismatch');
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
    yield Buffer.alloc(BLOCK * 2); // end-of-archive marker
  })());
}

function parseHeader(b) {
  if (b.every((x) => x === 0)) return null;
  const str = (o, l) => b.toString('utf8', o, o + l).replace(/\0[\s\S]*$/, '');
  let size;
  if (b[124] & 0x80) { size = 0; for (let i = 125; i < 136; i++) size = size * 256 + b[i]; } // base-256 (huge files)
  else size = parseInt(str(124, 12).trim() || '0', 8);
  return { name: str(0, 100), size, type: String.fromCharCode(b[156] || 48) };
}

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
