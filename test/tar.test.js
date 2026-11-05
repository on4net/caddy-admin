import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileHeader, extractTar } from '../src/tar.js';

const tarOf = (name, text, mode) => Buffer.concat([
  fileHeader(name, text.length, { mode }), Buffer.from(text), Buffer.alloc((512 - (text.length % 512)) % 512), Buffer.alloc(1024),
]);

test('extracting an untrusted tar never restores setuid/setgid/sticky bits', { skip: process.platform === 'win32' && 'POSIX modes only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadt-'));
  await extractTar(Readable.from([tarOf('evil-suid', '#!/bin/sh\n', 0o6755)]), dir);
  const mode = fs.statSync(path.join(dir, 'evil-suid')).mode;
  assert.equal(mode & 0o7000, 0, `special bits must be stripped, got ${(mode & 0o7777).toString(8)}`);
  assert.equal(mode & 0o777, 0o755); // normal permissions are kept
});

test('extractTar refuses path traversal and absolute names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadt-'));
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  const s = await extractTar(Readable.from([tarOf('../escaped.txt', 'x', 0o644)]), out);
  assert.deepEqual(s.skipped, ['../escaped.txt']);
  assert.ok(!fs.existsSync(path.join(dir, 'escaped.txt')));
});
