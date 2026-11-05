import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---- fake Docker engine on a unix socket / named pipe ----
const SELF = (os.hostname() + 'f'.repeat(64)).slice(0, 64);
const OTHER = 'a'.repeat(64);
// Minimal STORED zip writer so tests can build archives yazl refuses to write (e.g. "../evil.txt").
function rawZip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), data = f.data, crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const chunk = Buffer.concat([lh, name, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100644 << 16) >>> 0), 38); ch.writeUInt32LE(offset, 42);
    locals.push(chunk); centrals.push(Buffer.concat([ch, name])); offset += chunk.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const dk = { calls: [], createAttempts: 0, execN: 0, execs: {}, resizes: [] };
const { fileHeader } = await import('../src/tar.js');
const tarOf = (name, text) => Buffer.concat([fileHeader(name, text.length), Buffer.from(text), Buffer.alloc(512 - text.length), Buffer.alloc(1024)]);
const DIR_TAR = Buffer.from('FAKE-DIRECTORY-TAR');
const STATS = 'link|W|1700000300|777|0|0'+String.fromCharCode(10)+'sub|0|1700000000|755|0|0\na.txt|1700000100|1700000200|644|0|0\n';
const tarOfBuf = (name, buf) => Buffer.concat([fileHeader(name, buf.length), buf, Buffer.alloc((512 - (buf.length % 512)) % 512), Buffer.alloc(1024)]);
const ZIP_BYTES = rawZip([{ name: 'inner.txt', data: Buffer.from('zipped hello') }, { name: 'dir/deep.txt', data: Buffer.from('deep') }]);
const LISTING = `total 12
drwxr-xr-x    2 0        0             4096 Nov  5 07:46 sub/
-rw-r--r--    1 0        0                6 Nov  5 07:46 a.txt
lrwxrwxrwx    1 0        0                5 Nov  5 07:46 link -> a.txt
-rw-r--r--    1 1000     1000             0 Nov  5 07:46 my file.txt
crw-rw-rw-    1 0        0           1,   3 Nov  5 07:46 null
`;
const frame = (type, text) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\cadm-test-${process.pid}` : path.join(os.tmpdir(), `cadm-${process.pid}.sock`);
const fakeDocker = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    dk.calls.push(`${req.method} ${req.url}`);
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (u === '/containers/json?all=1') return json([
      { Id: OTHER, Names: ['/web'], Image: 'nginx', State: 'running', Status: 'Up 1h', Ports: [{ PublicPort: 8080, PrivatePort: 80, Type: 'tcp', IP: '0.0.0.0' }], Created: 1, Labels: {}, NetworkSettings: { Networks: { proxy: {} } } },
      { Id: SELF, Names: ['/panel'], Image: 'caddy-admin', State: 'running', Status: 'Up', Ports: null, Created: 2, Labels: {}, NetworkSettings: { Networks: {} } },
    ]);
    if (u === '/containers/json') return json([{ Id: OTHER, Names: ['/web'], Image: 'nginx' }]);
    if (u.startsWith(`/containers/${OTHER}/stats`)) return json({
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 200 } }, networks: { eth0: { rx_bytes: 5, tx_bytes: 7 } },
    });
    // ---- exec (non-interactive), exec results ----
    if (req.method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(u)) {
      const id = `ex${++dk.execN}`; dk.execs[id] = JSON.parse(body); return json({ Id: id }, 201);
    }
    if (req.method === 'POST' && /^\/exec\/ex\d+\/start$/.test(u)) {
      const cmd = dk.execs[u.split('/')[2]].Cmd; dk.lastCmd = cmd;
      res.writeHead(200);
      if (cmd[0] === 'ls' && cmd.at(-1).startsWith('/missing')) return res.end(frame(2, 'ls: /missing: No such file or directory\n'));
      if (cmd[0] === 'ls') return res.end(frame(1, LISTING));
      if (cmd[0] === 'sh') return res.end(frame(1, STATS));
      if (cmd[0] === 'nope') return res.end(frame(2, 'OCI runtime exec failed: executable file not found in $PATH\n'));
      return res.end();
    }
    if (/^\/exec\/ex\d+\/json$/.test(u)) {
      const cmd = dk.execs[u.split('/')[2]].Cmd;
      return json({ ExitCode: cmd[0] === 'ls' && cmd.at(-1).startsWith('/missing') ? 2 : 0 });
    }
    if (req.method === 'POST' && u.startsWith('/exec/') && u.includes('/resize')) { dk.resizes.push(u); res.writeHead(200); return res.end(); }
    // ---- archive API (file manager inside container) ----
    if (u.startsWith(`/containers/${OTHER}/archive`) || u.startsWith(`/containers/${OTHER.slice(0, 12)}/archive`)) {
      const p = new URL(u, 'http://x').searchParams.get('path');
      const stat = { '/etc/hello.txt': { name: 'hello.txt', size: 11, mode: 420 }, '/etc': { name: 'etc', size: 4096, mode: 2147484141 },
        '/etc/link': { name: 'link', size: 9, mode: 134218239, linkTarget: 'hello.txt' }, '/etc/hello.zip': { name: 'hello.zip', size: ZIP_BYTES.length, mode: 420 } }[p];
      if (req.method === 'PUT') { dk.putTar = Buffer.from(body, 'latin1'); dk.putPath = p; res.writeHead(200); return res.end(); }
      if (!stat) { res.writeHead(404); return res.end(); }
      res.setHeader('X-Docker-Container-Path-Stat', Buffer.from(JSON.stringify(stat)).toString('base64'));
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      res.writeHead(200);
      return res.end(p === '/etc' ? DIR_TAR : p === '/etc/hello.zip' ? tarOfBuf('hello.zip', ZIP_BYTES) : tarOf('hello.txt', 'hello world'));
    }
    if (u.endsWith('/json') && u.startsWith('/containers/')) return json({ Config: { Tty: false }, Name: '/web' });
    if (u.startsWith('/containers/') && u.includes('/logs')) { res.writeHead(200); return res.end(Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')])); }
    if (u.startsWith('/containers/create')) {
      if (++dk.createAttempts === 1) return json({ message: 'No such image: redis:7' }, 404);
      dk.createBody = JSON.parse(body); return json({ Id: 'c'.repeat(64) }, 201);
    }
    if (u.startsWith('/images/create')) { res.writeHead(200); return res.end('{"status":"Pulling"}\n{"status":"Done"}\n'); }
    if (/^\/containers\/[^/]+\/(start|stop|restart)/.test(u)) { res.writeHead(204); return res.end(); }
    if (u === '/info') return json({ Containers: 2, ContainersRunning: 2, ContainersPaused: 0, ContainersStopped: 0, Images: 3, OperatingSystem: 'Test', KernelVersion: '1' });
    if (u === '/version') return json({ Version: '29.0', ApiVersion: '1.50' });
    json({ message: 'unexpected ' + u }, 500);
  });
});
fakeDocker.on('upgrade', (req, socket) => { // hijacked TTY exec: print a prompt, echo input
  socket.write(['HTTP/1.1 101 UPGRADED', 'Content-Type: application/vnd.docker.raw-stream', 'Connection: Upgrade', 'Upgrade: tcp', '', ''].join('\r\n'));
  socket.write('welcome$ ');
  socket.on('data', (d) => { if (!d.toString().startsWith('{"Detach"')) socket.write(d); });
});
if (process.platform !== 'win32') fs.rmSync(sockPath, { force: true });
await new Promise((r) => fakeDocker.listen(sockPath, r));

// ---- env ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadf-'));
const rwDir = path.join(tmp, 'rw'), roDir = path.join(tmp, 'ro'), outside = path.join(tmp, 'outside');
for (const d of [rwDir, roDir, outside]) fs.mkdirSync(d);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
fs.writeFileSync(path.join(roDir, 'readme.txt'), 'hi');
let linked = true;
try { fs.symlinkSync(outside, path.join(rwDir, 'escape'), 'junction'); } catch { linked = false; }

process.env.DATA_DIR = path.join(tmp, 'data');
process.env.MAX_EXTRACT_MB = '1'; // small cap so the zip-bomb test is cheap
process.env.DOCKER_SOCKET = sockPath;
process.env.FILE_ROOTS = `data|Data|rw|${rwDir},logs|Logs|ro|${roDir}`;
process.env.ADMIN_EMAIL = 'admin@test.io';
process.env.ADMIN_PASSWORD = 'secret-pass-1';
process.env.CADDY_ADMIN_URL = 'http://127.0.0.1:1';

const { createApp } = await import('../src/server.js');
const { attachTerminal } = await import('../src/terminal.js');
const { WebSocket } = await import('ws');
const { bootstrapAdmin } = await import('../src/auth.js');
const { db } = await import('../src/db.js');
await bootstrapAdmin();

let base, server, cookie, userCookie;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  attachTerminal(server);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const login = (email, password) => fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  cookie = (await login('admin@test.io', 'secret-pass-1')).headers.get('set-cookie').split(';')[0];
  await call('POST', '/users', { email: 'u@test.io', password: 'password-123', role: 'user' });
  userCookie = (await login('u@test.io', 'password-123')).headers.get('set-cookie').split(';')[0];
});
after(() => { server.closeAllConnections?.(); server.close(); fakeDocker.close(); db.close(); });

async function call(method, url, body, ck = cookie, raw) {
  const r = await fetch(base + url, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), Cookie: ck }, body: raw ?? (body && JSON.stringify(body)) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}

// ---------------- docker ----------------
test('docker + files are admin only', async () => {
  for (const u of ['/docker/containers', '/fm/sources']) assert.equal((await call('GET', u, null, userCookie)).status, 403);
});

test('docker: list containers, flags self, formats ports', async () => {
  const r = await call('GET', '/docker/containers');
  assert.equal(r.status, 200);
  const web = r.body.find((c) => c.name === 'web');
  assert.equal(web.ports, '8080->80/tcp');
  assert.equal(web.self, false);
  assert.equal(r.body.find((c) => c.name === 'panel').self, true);
});

test('docker: stats are computed (cpu%, memory minus cache)', async () => {
  const r = await call('GET', '/docker/containers/stats');
  const s = r.body[OTHER.slice(0, 12)];
  assert.equal(s.cpu, 20); // (100/1000)*2cpu*100
  assert.equal(s.memUsed, 800);
  assert.equal(s.netRx, 5);
});

test('docker: actions, self-protection, validation', async () => {
  assert.equal((await call('POST', `/docker/containers/${OTHER.slice(0, 12)}/restart`)).status, 200);
  assert.ok(dk.calls.includes(`POST /containers/${OTHER.slice(0, 12)}/restart`));
  assert.equal((await call('POST', `/docker/containers/${SELF.slice(0, 12)}/stop`)).status, 400);
  assert.equal((await call('DELETE', `/docker/containers/${SELF.slice(0, 12)}`)).status, 400);
  assert.equal((await call('POST', `/docker/containers/${OTHER.slice(0, 12)}/explode`)).status, 400);
  assert.equal((await call('POST', '/docker/containers/..%2Fetc/start')).status, 400);
});

test('docker: logs are demultiplexed', async () => {
  const r = await call('GET', `/docker/containers/${OTHER.slice(0, 12)}/logs`);
  assert.equal(r.body.logs, 'hello\noops\n');
});

test('docker: run container pulls a missing image, builds ports/env/volumes/restart', async () => {
  const r = await call('POST', '/docker/containers', {
    image: 'redis:7', name: 'cache', ports: '6379:6379\n127.0.0.1:9000:9000/udp', env: 'A=1', volumes: '/srv/x:/data:ro', restart: 'unless-stopped',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(dk.calls.some((c) => c.startsWith('POST /images/create?fromImage=redis&tag=7')));
  assert.deepEqual(dk.createBody.HostConfig.PortBindings['6379/tcp'], [{ HostPort: '6379' }]);
  assert.deepEqual(dk.createBody.HostConfig.PortBindings['9000/udp'], [{ HostPort: '9000', HostIp: '127.0.0.1' }]);
  assert.deepEqual(dk.createBody.Env, ['A=1']);
  assert.deepEqual(dk.createBody.HostConfig.Binds, ['/srv/x:/data:ro']);
  assert.equal(dk.createBody.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal((await call('POST', '/docker/containers', { image: 'x; rm -rf /' })).status, 400);
  assert.equal((await call('POST', '/docker/containers', { image: 'ok', ports: 'abc' })).status, 400);
});

test('docker: unreachable socket gives a clear 503', async () => {
  const old = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = sockPath + '-missing';
  const r = await call('GET', '/docker/info');
  process.env.DOCKER_SOCKET = old;
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not reachable/);
});

// ---------------- monitoring ----------------
test('system stats: cpu, memory, disks (incl. mounted folders), history', async () => {
  const s = (await call('GET', '/system')).body;
  assert.ok(s.memory.total > 0 && s.memory.free >= 0);
  assert.ok(typeof s.cpuPercent === 'number');
  assert.ok(Array.isArray(s.disks) && s.disks.length >= 1);
  const d = s.disks[0];
  assert.equal(d.used + d.free <= d.total + 1, true);
  const h = (await call('GET', '/system/history')).body;
  assert.ok(h.length >= 1 && 'cpu' in h[0]);
});

// ---------------- container logs: live follow + download ----------------
test('docker logs: SSE follow streams lines then ends; download is plain text', async () => {
  const r = await fetch(base + `/docker/containers/${OTHER.slice(0, 12)}/logs/stream?tail=50`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text(); // the fake docker ends the stream, so the server sends "end"
  assert.match(text, /data: \["hello"\]/);
  assert.match(text, /data: \["oops"\]/);
  assert.match(text, /event: end/);
  assert.ok(dk.calls.some((c) => c.includes('/logs?') && c.includes('follow=1') && c.includes('tail=50')));
  const d = await fetch(base + `/docker/containers/${OTHER.slice(0, 12)}/logs/download`, { headers: { Cookie: cookie } });
  assert.match(d.headers.get('content-disposition'), /web\.log/);
  assert.equal(await d.text(), 'hello\noops\n');
});

// ---------------- terminal (WebSocket) ----------------
const CID = OTHER.slice(0, 12);
const wsUrl = (extra = '') => `ws://127.0.0.1:${server.address().port}/api/docker/containers/${CID}/exec?cols=100&rows=30${extra}`;
const failStatus = (url, opts) => new Promise((resolve) => {
  const ws = new WebSocket(url, opts);
  ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
  ws.on('open', () => { ws.close(); resolve('opened'); });
  ws.on('error', () => {});
});

test('terminal: needs an admin session and same-origin', async () => {
  assert.equal(await failStatus(wsUrl()), 401);
  assert.equal(await failStatus(wsUrl(), { headers: { Cookie: userCookie } }), 403);
  assert.equal(await failStatus(wsUrl(), { headers: { Cookie: cookie, Origin: 'http://evil.example.com' } }), 403);
  assert.equal(await failStatus(`ws://127.0.0.1:${server.address().port}/api/docker/containers/${CID}/other`, { headers: { Cookie: cookie } }), 404);
});

test('terminal: interactive session bridges input/output, resizes, and is audited', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ws = new WebSocket(wsUrl('&user=root&shell=bash'), { headers: { Cookie: cookie, Origin: origin } });
  const got = [];
  ws.on('message', (d) => got.push(d.toString()));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const until = async (re) => { for (let i = 0; i < 100 && !re.test(got.join('')); i++) await new Promise((r) => setTimeout(r, 20)); return got.join(''); };
  assert.match(await until(/welcome\$ /), /welcome\$ /);
  ws.send(Buffer.from('ls -la\n'));            // keystrokes = binary frame
  assert.match(await until(/ls -la/), /ls -la/);   // echoed back from the "container"
  ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
  for (let i = 0; i < 50 && !dk.resizes.some((r) => r.includes('h=40&w=120')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(dk.resizes.some((r) => r.includes('h=30&w=100')), 'initial size sent');
  assert.ok(dk.resizes.some((r) => r.includes('h=40&w=120')), 'resize forwarded');
  const create = Object.values(dk.execs).find((e) => e.Tty);
  assert.equal(create.User, 'root'); assert.deepEqual(create.Cmd, ['/bin/bash']); assert.equal(create.AttachStdin, true);
  ws.close();
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='docker_exec'").get());
});

test('terminal: rejects a malicious user parameter', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ws = new WebSocket(wsUrl('&user=root;id'), { headers: { Cookie: cookie, Origin: origin } });
  const code = await new Promise((r) => { ws.on('close', (c) => r(c)); ws.on('error', () => {}); });
  assert.equal(code, 1008);
});

// ================= unified file manager (/api/fm) =================
const H = 'host:data', RO = 'host:logs', CT = `container:${OTHER.slice(0, 12)}`;
const Q = (o) => new URLSearchParams(o).toString();
const raw = (method, url, ck, body, headers = {}) => fetch(base + url, { method, headers: { Cookie: ck ?? cookie, ...headers }, body });
const put = (url, buf) => raw('PUT', url, cookie, buf);

test('fm: sources list host folders and running containers', async () => {
  const r = (await call('GET', '/fm/sources')).body;
  assert.deepEqual(r.hosts.map((h) => [h.id, h.writable]), [['host:data', true], ['host:logs', false]]);
  assert.ok(r.containers.some((c) => c.id === CT && c.name === 'web'));
});

test('fm: host listing has size, created, modified, permissions; sorted dirs first', async () => {
  fs.mkdirSync(path.join(rwDir, 'adir'), { recursive: true });
  fs.writeFileSync(path.join(rwDir, 'note.txt'), 'hello');
  const r = (await call('GET', `/fm/list?${Q({ src: H, path: '/' })}`)).body;
  assert.equal(r.source.label, 'Data');
  const n = r.entries.find((e) => e.name === 'note.txt');
  assert.equal(n.size, 5); assert.equal(typeof n.mtime, 'number'); assert.ok(n.birth === null || typeof n.birth === 'number');
  assert.match(n.mode, /^-[rwx-]{9}$/);
  assert.equal(r.entries[0].type, 'dir');
  assert.ok(n.mtime > 1.6e12); // milliseconds
});

test('fm: traversal / unknown source / non-admin are rejected', async () => {
  for (const p of ['../outside', '/../outside/secret.txt', 'a/../../outside']) assert.equal((await call('GET', `/fm/list?${Q({ src: H, path: p })}`)).status, 400, p);
  assert.equal((await call('GET', `/fm/list?${Q({ src: 'host:nope', path: '/' })}`)).status, 400);
  assert.equal((await call('GET', `/fm/list?${Q({ src: 'bogus', path: '/' })}`)).status, 400);
  assert.equal((await call('GET', `/fm/list?${Q({ src: H, path: '/' })}`, null, userCookie)).status, 403);
});

test('fm: symlink cannot escape the root; deleting a link keeps its target', { skip: !linked && 'cannot create symlink here' }, async () => {
  assert.equal((await call('GET', `/fm/list?${Q({ src: H, path: '/escape' })}`)).status, 400);
  assert.equal((await call('GET', `/fm/download?${Q({ src: H, path: '/escape/secret.txt' })}`)).status, 400);
  assert.equal((await call('POST', '/fm/delete', { src: H, paths: ['/escape'] })).status, 200);
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
});

test('fm: create file/folder, upload, view + edit text, rename, delete', async () => {
  assert.equal((await call('POST', '/fm/mkdir', { src: H, path: '/', name: 'docs' })).status, 201);
  assert.equal((await call('POST', '/fm/mkdir', { src: H, path: '/', name: 'docs' })).status, 400);        // exists
  assert.equal((await call('POST', '/fm/mkdir', { src: H, path: '/', name: 'docs', existOk: true })).status, 201); // folder upload helper
  assert.equal((await call('POST', '/fm/mkfile', { src: H, path: '/docs', name: 'empty.txt' })).status, 201);
  assert.equal(fs.statSync(path.join(rwDir, 'docs', 'empty.txt')).size, 0);
  assert.equal((await put(`/fm/upload?${Q({ src: H, path: '/docs', name: 'a.txt' })}`, Buffer.from('hello world'))).status, 201);
  assert.equal((await put(`/fm/upload?${Q({ src: H, path: '/docs', name: 'a.txt' })}`, Buffer.from('x'))).status, 400); // no overwrite
  assert.equal((await put(`/fm/upload?${Q({ src: H, path: '/docs', name: '../evil.txt' })}`, Buffer.from('x'))).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(rwDir, 'docs')).sort(), ['a.txt', 'empty.txt']); // no .part leftovers

  const read = (await call('GET', `/fm/read?${Q({ src: H, path: '/docs/a.txt' })}`)).body;
  assert.equal(read.content, 'hello world'); assert.equal(read.writable, true);
  const w = await raw('PUT', `/fm/write?${Q({ src: H, path: '/docs/a.txt' })}`, cookie, 'edited ✓ text', { 'Content-Type': 'text/plain; charset=utf-8' });
  assert.equal(w.status, 200);
  assert.equal(fs.readFileSync(path.join(rwDir, 'docs', 'a.txt'), 'utf8'), 'edited ✓ text');

  fs.writeFileSync(path.join(rwDir, 'docs', 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  assert.equal((await call('GET', `/fm/read?${Q({ src: H, path: '/docs/bin.dat' })}`)).status, 415);

  assert.equal((await call('POST', '/fm/rename', { src: H, path: '/docs/a.txt', newName: 'b.txt' })).status, 200);
  assert.equal((await call('POST', '/fm/rename', { src: H, path: '/docs/b.txt', newName: '../c.txt' })).status, 400);
  assert.equal((await call('POST', '/fm/delete', { src: H, paths: ['/docs/b.txt', '/docs/bin.dat'] })).body.deleted, 2);
  assert.equal((await call('POST', '/fm/delete', { src: H, paths: ['/'] })).status, 400); // never the root
});

test('fm: download (attachment), inline only for safe types, folder as tar', async () => {
  fs.writeFileSync(path.join(rwDir, 'pic.png'), Buffer.from('PNGDATA'));
  fs.writeFileSync(path.join(rwDir, 'page.html'), '<script>alert(1)</script>');
  const f = await raw('GET', `/fm/download?${Q({ src: H, path: '/note.txt' })}`);
  assert.equal(await f.text(), 'hello'); assert.match(f.headers.get('content-disposition'), /^attachment/);
  const img = await raw('GET', `/fm/download?${Q({ src: H, path: '/pic.png', inline: 1 })}`);
  assert.equal(img.headers.get('content-type'), 'image/png'); assert.match(img.headers.get('content-disposition'), /^inline/);
  assert.match(img.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await raw('GET', `/fm/download?${Q({ src: H, path: '/page.html', inline: 1 })}`);
  assert.match(html.headers.get('content-disposition'), /^attachment/); // html is never rendered inline
  assert.equal(html.headers.get('content-type'), 'application/octet-stream');
  const dir = await raw('GET', `/fm/download?${Q({ src: H, path: '/adir' })}`);
  assert.equal(dir.headers.get('content-type'), 'application/x-tar');
  assert.equal((await dir.arrayBuffer()).byteLength % 512, 0);
});

test('fm: read-only folder rejects every change', async () => {
  assert.equal((await put(`/fm/upload?${Q({ src: RO, path: '/', name: 'x.txt' })}`, Buffer.from('x'))).status, 400);
  assert.equal((await call('POST', '/fm/mkdir', { src: RO, path: '/', name: 'd' })).status, 400);
  assert.equal((await call('POST', '/fm/mkfile', { src: RO, path: '/', name: 'f' })).status, 400);
  assert.equal((await call('POST', '/fm/delete', { src: RO, paths: ['/readme.txt'] })).status, 400);
  assert.equal((await call('POST', '/fm/zip', { src: RO, path: '/', paths: ['/readme.txt'], name: 'z' })).status, 400);
  assert.equal((await raw('PUT', `/fm/write?${Q({ src: RO, path: '/readme.txt' })}`, cookie, 'x', { 'Content-Type': 'text/plain' })).status, 400);
  assert.ok(fs.existsSync(path.join(roDir, 'readme.txt')));
});

test('fm: copy and move folders/files between folders (also from read-only), conflicts and self-nesting refused', async () => {
  fs.mkdirSync(path.join(rwDir, 'src', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(rwDir, 'src', 'inner', 'f.txt'), 'deep');
  fs.mkdirSync(path.join(rwDir, 'dst'));
  const T = (mode, from, paths, to, dir) => call('POST', '/fm/transfer', { mode, from: { src: from, paths }, to: { src: to, path: dir } });
  assert.equal((await T('copy', H, ['/src'], H, '/dst')).status, 200);
  assert.equal(fs.readFileSync(path.join(rwDir, 'dst', 'src', 'inner', 'f.txt'), 'utf8'), 'deep');
  assert.ok(fs.existsSync(path.join(rwDir, 'src'))); // copy keeps the source
  assert.equal((await T('copy', H, ['/src'], H, '/dst')).status, 400);   // already exists
  assert.equal((await T('move', H, ['/src'], H, '/src/inner')).status, 400); // into itself
  assert.equal((await T('copy', RO, ['/readme.txt'], H, '/dst')).status, 200); // from the read-only mount
  assert.equal(fs.readFileSync(path.join(rwDir, 'dst', 'readme.txt'), 'utf8'), 'hi');
  assert.equal((await T('move', H, ['/dst/readme.txt'], H, '/adir')).status, 200);
  assert.ok(!fs.existsSync(path.join(rwDir, 'dst', 'readme.txt')) && fs.existsSync(path.join(rwDir, 'adir', 'readme.txt')));
  assert.equal((await T('move', RO, ['/readme.txt'], H, '/dst')).status, 400); // cannot move OUT of read-only
  assert.ok(fs.existsSync(path.join(roDir, 'readme.txt')));
});

test('fm: zip and unzip (here / into folder), overwrite protection', async () => {
  fs.mkdirSync(path.join(rwDir, 'ziptest', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(rwDir, 'ziptest', 'one.txt'), 'one');
  fs.writeFileSync(path.join(rwDir, 'ziptest', 'sub', 'two.txt'), 'two');
  fs.writeFileSync(path.join(rwDir, 'solo.txt'), 'solo');
  const z = await call('POST', '/fm/zip', { src: H, path: '/', paths: ['/ziptest', '/solo.txt'], name: 'bundle' });
  assert.equal(z.status, 201, JSON.stringify(z.body)); assert.equal(z.body.name, 'bundle.zip');
  assert.equal((await call('POST', '/fm/zip', { src: H, path: '/', paths: ['/solo.txt'], name: 'bundle.zip' })).status, 400); // exists
  assert.ok(fs.statSync(path.join(rwDir, 'bundle.zip')).size > 100);

  fs.mkdirSync(path.join(rwDir, 'out'));
  const u = await call('POST', '/fm/unzip', { src: H, path: '/bundle.zip', dest: '/out' });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(fs.readFileSync(path.join(rwDir, 'out', 'ziptest', 'sub', 'two.txt'), 'utf8'), 'two');
  assert.equal(fs.readFileSync(path.join(rwDir, 'out', 'solo.txt'), 'utf8'), 'solo');
  assert.equal((await call('POST', '/fm/unzip', { src: H, path: '/bundle.zip', dest: '/out' })).status, 400); // would overwrite
  assert.equal((await call('POST', '/fm/unzip', { src: H, path: '/bundle.zip', dest: '/out', overwrite: true })).status, 200);

  const f = await call('POST', '/fm/unzip', { src: H, path: '/bundle.zip', folder: true });
  assert.equal(f.status, 200); assert.ok(fs.existsSync(path.join(rwDir, 'bundle', 'solo.txt'))); // into a folder named after the zip
  assert.equal((await call('POST', '/fm/unzip', { src: H, path: '/note.txt' })).status, 400);    // not a zip
});

test('fm: unzip is safe against zip slip and zip bombs', async () => {
  const evil = rawZip([{ name: '../evil-slip.txt', data: Buffer.from('pwn') }]);
  fs.writeFileSync(path.join(rwDir, 'evil.zip'), evil);
  fs.mkdirSync(path.join(rwDir, 'safe'));
  const r = await call('POST', '/fm/unzip', { src: H, path: '/evil.zip', dest: '/safe' });
  assert.equal(r.status, 400);
  assert.ok(!fs.existsSync(path.join(rwDir, 'evil-slip.txt')) && !fs.existsSync(path.join(tmp, 'evil-slip.txt')));

  const bomb = rawZip([{ name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024) }]); // MAX_EXTRACT_MB=1 in this test run
  fs.writeFileSync(path.join(rwDir, 'bomb.zip'), bomb);
  fs.mkdirSync(path.join(rwDir, 'bombout'));
  const b = await call('POST', '/fm/unzip', { src: H, path: '/bomb.zip', dest: '/bombout' });
  assert.equal(b.status, 400); assert.match(b.body.error, /size limit/);
  assert.ok(!fs.existsSync(path.join(rwDir, 'bombout', 'big.bin')) || fs.statSync(path.join(rwDir, 'bombout', 'big.bin')).size <= 1024 * 1024);
});

// ---- container side (fake docker) ----
test('fm container: list merges ls with stat (exact modified time, creation time when known)', async () => {
  const r = (await call('GET', `/fm/list?${Q({ src: CT, path: '/etc' })}`)).body;
  const a = r.entries.find((e) => e.name === 'a.txt'), sub = r.entries.find((e) => e.name === 'sub');
  assert.equal(a.mtime, 1700000200000); assert.equal(a.birth, 1700000100000);
  assert.equal(sub.mtime, 1700000000000); assert.equal(sub.birth, null); // %W = 0 -> unknown
  const lnk = r.entries.find((e) => e.name === 'link');
  assert.equal(lnk.mtime, 1700000300000); assert.equal(lnk.birth, null); // BusyBox prints a literal W for %W
  assert.equal(a.mode, '-rw-r--r--'); assert.equal(a.size, 6);
  assert.equal(dk.lastCmd[0], 'sh'); assert.equal(dk.lastCmd.at(-1), '/etc'); // dir passed as an argument, not interpolated
  const missing = await call('GET', `/fm/list?${Q({ src: CT, path: '/missing' })}`);
  assert.equal(missing.status, 400);
});

test('fm container: view, edit (keeps a valid tar), mkfile, upload, download', async () => {
  const read = (await call('GET', `/fm/read?${Q({ src: CT, path: '/etc/hello.txt' })}`)).body;
  assert.equal(read.content, 'hello world');
  const w = await raw('PUT', `/fm/write?${Q({ src: CT, path: '/etc/hello.txt' })}`, cookie, 'changed', { 'Content-Type': 'text/plain' });
  assert.equal(w.status, 200); assert.equal(dk.putPath, '/etc');
  assert.equal(dk.putTar.toString('latin1', 0, 9), 'hello.txt'); assert.equal(dk.putTar.toString('latin1', 512, 519), 'changed');
  assert.equal((await call('POST', '/fm/mkfile', { src: CT, path: '/etc', name: 'new.txt' })).status, 201);
  assert.equal(dk.putTar.toString('latin1', 0, 7), 'new.txt');
  assert.equal((await put(`/fm/upload?${Q({ src: CT, path: '/etc', name: 'up.bin' })}`, Buffer.from('payload!'))).status, 201);
  assert.equal(dk.putTar.toString('latin1', 512, 520), 'payload!');
  const d = await raw('GET', `/fm/download?${Q({ src: CT, path: '/etc/link' })}`); // symlink followed
  assert.equal(await d.text(), 'hello world');
  assert.equal((await put(`/fm/upload?${Q({ src: CT, path: '/etc', name: 'hello.txt' })}`, Buffer.from('x'))).status, 400); // exists
});

test('fm container: mkdir/rename/delete/copy/move inside a container use argv commands', async () => {
  assert.equal((await call('POST', '/fm/mkdir', { src: CT, path: '/data', name: 'new dir' })).status, 201);
  assert.deepEqual(dk.lastCmd, ['mkdir', '--', '/data/new dir']);
  assert.equal((await call('POST', '/fm/rename', { src: CT, path: '/data/a', newName: 'b' })).status, 200);
  assert.deepEqual(dk.lastCmd, ['mv', '--', '/data/a', '/data/b']);
  const T = (mode, paths, dir) => call('POST', '/fm/transfer', { mode, from: { src: CT, paths }, to: { src: CT, path: dir } });
  assert.equal((await T('copy', ['/data/x'], '/tmp')).status, 200);
  assert.deepEqual(dk.lastCmd, ['cp', '-a', '--', '/data/x', '/tmp/x']);
  assert.equal((await T('move', ['/data/x'], '/tmp')).status, 200);
  assert.deepEqual(dk.lastCmd, ['mv', '--', '/data/x', '/tmp/x']);
  assert.equal((await T('copy', ['/data'], '/data/sub')).status, 400); // into itself
  assert.equal((await call('POST', '/fm/delete', { src: CT, paths: ['/data/old'] })).status, 200);
  assert.deepEqual(dk.lastCmd, ['rm', '-rf', '--', '/data/old']);
  assert.equal((await call('POST', '/fm/delete', { src: CT, paths: ['/../..'] })).status, 400);
});

test('fm: transfer host -> container and container -> host (tar streamed between them), move removes the source', async () => {
  fs.mkdirSync(path.join(rwDir, 'tosend', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(rwDir, 'tosend', 'inner', 'file.txt'), 'from the host');
  const T = (mode, from, paths, to, dir) => call('POST', '/fm/transfer', { mode, from: { src: from, paths }, to: { src: to, path: dir } });
  assert.equal((await T('copy', H, ['/tosend'], CT, '/etc')).status, 200);
  assert.equal(dk.putPath, '/etc');
  const names = []; // entry names in the tar that was pushed to the container
  for (let i = 0; i + 512 <= dk.putTar.length;) {
    const h = dk.putTar.subarray(i, i + 512); if (h.every((x) => x === 0)) break;
    const size = parseInt(h.toString('latin1', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    names.push(h.toString('latin1', 0, 100).replace(/\0.*$/, '')); i += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names, ['tosend/', 'tosend/inner/', 'tosend/inner/file.txt']);
  assert.ok(dk.putTar.includes('from the host'));

  assert.equal((await T('copy', CT, ['/etc/hello.txt'], H, '/dst')).status, 200); // container -> host via tar extraction
  assert.equal(fs.readFileSync(path.join(rwDir, 'dst', 'hello.txt'), 'utf8'), 'hello world');
  assert.equal((await T('copy', CT, ['/etc/hello.txt'], H, '/dst')).status, 400);  // exists now
  fs.rmSync(path.join(rwDir, 'dst', 'hello.txt'));
  assert.equal((await T('move', CT, ['/etc/hello.txt'], H, '/dst')).status, 200);
  assert.deepEqual(dk.lastCmd, ['rm', '-rf', '--', '/etc/hello.txt']); // source removed after a successful move
  assert.equal(fs.readFileSync(path.join(rwDir, 'dst', 'hello.txt'), 'utf8'), 'hello world');
});

test('fm container: zip a file into the container and unzip an archive inside it', async () => {
  const z = await call('POST', '/fm/zip', { src: CT, path: '/etc', paths: ['/etc/hello.txt'], name: 'pack' });
  assert.equal(z.status, 201, JSON.stringify(z.body));
  assert.equal(dk.putTar.toString('latin1', 0, 8), 'pack.zip');
  assert.equal(dk.putTar.toString('latin1', 512, 514), 'PK'); // a real zip went into the container

  const u = await call('POST', '/fm/unzip', { src: CT, path: '/etc/hello.zip', dest: '/etc' });
  assert.equal(u.status, 200, JSON.stringify(u.body)); assert.equal(u.body.files, 2);
  assert.ok(dk.putTar.includes('zipped hello') && dk.putTar.includes('dir/deep.txt'));
  const uf = await call('POST', '/fm/unzip', { src: CT, path: '/etc/hello.zip', dest: '/etc', folder: true });
  assert.equal(uf.status, 200); assert.ok(dk.putTar.includes('hello/inner.txt'));
});
