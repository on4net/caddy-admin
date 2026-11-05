import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- fake Docker engine on a unix socket / named pipe ----
const SELF = (os.hostname() + 'f'.repeat(64)).slice(0, 64);
const OTHER = 'a'.repeat(64);
const dk = { calls: [], createAttempts: 0, execN: 0, execs: {}, resizes: [] };
const { fileHeader } = await import('../src/tar.js');
const tarOf = (name, text) => Buffer.concat([fileHeader(name, text.length), Buffer.from(text), Buffer.alloc(512 - text.length), Buffer.alloc(1024)]);
const DIR_TAR = Buffer.from('FAKE-DIRECTORY-TAR');
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
      { Id: SELF, Names: ['/panel'], Image: 'caddy-admin', State: 'running', Status: 'Up', Ports: [], Created: 2, Labels: {}, NetworkSettings: { Networks: {} } },
    ]);
    if (u === '/containers/json') return json([{ Id: OTHER }]);
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
        '/etc/link': { name: 'link', size: 9, mode: 134218239, linkTarget: 'hello.txt' } }[p];
      if (req.method === 'PUT') { dk.putTar = Buffer.from(body, 'latin1'); dk.putPath = p; res.writeHead(200); return res.end(); }
      if (!stat) { res.writeHead(404); return res.end(); }
      res.setHeader('X-Docker-Container-Path-Stat', Buffer.from(JSON.stringify(stat)).toString('base64'));
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      res.writeHead(200);
      return res.end(p === '/etc' ? DIR_TAR : tarOf('hello.txt', 'hello world'));
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
  for (const u of ['/docker/containers', '/files/roots']) assert.equal((await call('GET', u, null, userCookie)).status, 403);
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

// ---------------- files ----------------
test('files: roots and listing', async () => {
  const roots = (await call('GET', '/files/roots')).body;
  assert.deepEqual(roots.map((r) => [r.slug, r.writable]), [['data', true], ['logs', false]]);
  const l = await call('GET', '/files/list?root=logs&path=/');
  assert.equal(l.body.entries[0].name, 'readme.txt');
});

test('files: path traversal and unknown root are rejected', async () => {
  for (const p of ['../outside', '/../outside/secret.txt', '..%2foutside', 'a/../../outside']) {
    const r = await call('GET', `/files/list?root=data&path=${p}`);
    assert.equal(r.status, 400, p);
  }
  assert.equal((await call('GET', '/files/list?root=nope&path=/')).status, 400);
  assert.equal((await call('GET', '/files/download?root=data&path=../outside/secret.txt')).status, 400);
});

test('files: symlink cannot escape the root', { skip: !linked && 'cannot create symlink here' }, async () => {
  assert.equal((await call('GET', '/files/list?root=data&path=/escape')).status, 400);
  assert.equal((await call('GET', '/files/download?root=data&path=/escape/secret.txt')).status, 400);
  // deleting the link removes the link, not the target
  assert.equal((await call('DELETE', '/files?root=data&path=/escape')).status, 200);
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
});

test('files: upload, download, mkdir, rename, delete', async () => {
  assert.equal((await call('POST', '/files/mkdir', { root: 'data', path: '/', name: 'docs' })).status, 201);
  const up = await call('PUT', '/files/upload?root=data&path=/docs&name=a.txt', null, cookie, Buffer.from('hello world'));
  assert.equal(up.status, 201);
  assert.equal(fs.readFileSync(path.join(rwDir, 'docs', 'a.txt'), 'utf8'), 'hello world');
  assert.equal((await call('PUT', '/files/upload?root=data&path=/docs&name=a.txt', null, cookie, Buffer.from('x'))).status, 400); // exists
  assert.equal((await call('PUT', '/files/upload?root=data&path=/docs&name=../evil.txt', null, cookie, Buffer.from('x'))).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(rwDir, 'docs')), ['a.txt']); // no leftover .part files

  const dl = await call('GET', '/files/download?root=data&path=/docs/a.txt');
  assert.equal(dl.body, 'hello world');
  assert.equal((await call('POST', '/files/rename', { root: 'data', path: '/docs/a.txt', newName: 'b.txt' })).status, 200);
  assert.equal((await call('POST', '/files/rename', { root: 'data', path: '/docs/b.txt', newName: '../c.txt' })).status, 400);
  assert.equal((await call('DELETE', '/files?root=data&path=/docs')).status, 200);
  assert.ok(!fs.existsSync(path.join(rwDir, 'docs')));
  assert.equal((await call('DELETE', '/files?root=data&path=/')).status, 400); // never the root itself
});

test('files: read-only root rejects every change', async () => {
  assert.equal((await call('PUT', '/files/upload?root=logs&path=/&name=x.txt', null, cookie, Buffer.from('x'))).status, 400);
  assert.equal((await call('POST', '/files/mkdir', { root: 'logs', path: '/', name: 'd' })).status, 400);
  assert.equal((await call('DELETE', '/files?root=logs&path=/readme.txt')).status, 400);
  assert.ok(fs.existsSync(path.join(roDir, 'readme.txt')));
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

// ---------------- file manager inside a container ----------------
const CID = OTHER.slice(0, 12);
test('container fs: list parses ls output (dirs first, links, spaces, devices)', async () => {
  const r = await call('GET', `/docker/containers/${CID}/fs/list?path=/etc`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(dk.lastCmd, ['ls', '-lAnp', '--', '/etc/']); // argv array, never a shell string
  const byName = Object.fromEntries(r.body.entries.map((e) => [e.name, e]));
  assert.equal(r.body.entries[0].name, 'sub'); assert.equal(byName.sub.type, 'dir');
  assert.equal(byName['a.txt'].size, 6);
  assert.equal(byName.link.type, 'link'); assert.equal(byName.link.target, 'a.txt');
  assert.ok(byName['my file.txt']); assert.equal(byName.null.type, 'special');
});

test('container fs: errors are explained; path tricks cannot inject flags', async () => {
  assert.equal((await call('GET', `/docker/containers/${CID}/fs/list?path=/missing`)).status, 400);
  await call('GET', `/docker/containers/${CID}/fs/list?path=--help`);
  assert.deepEqual(dk.lastCmd.slice(0, 3), ['ls', '-lAnp', '--']);
  assert.equal(dk.lastCmd.at(-1), '/--help/');
  assert.equal((await call('GET', '/docker/containers/..%2Fx/fs/list')).status, 400);
});

test('container fs: download file (tar unwrapped), symlink followed, folder as .tar, missing = 400', async () => {
  const f = await fetch(base + `/docker/containers/${CID}/fs/download?path=/etc/hello.txt`, { headers: { Cookie: cookie } });
  assert.equal(f.status, 200);
  assert.match(f.headers.get('content-disposition'), /hello\.txt/);
  assert.equal(f.headers.get('content-length'), '11');
  assert.equal(await f.text(), 'hello world');
  const l = await fetch(base + `/docker/containers/${CID}/fs/download?path=/etc/link`, { headers: { Cookie: cookie } });
  assert.equal(await l.text(), 'hello world'); // followed link -> /etc/hello.txt
  const d = await fetch(base + `/docker/containers/${CID}/fs/download?path=/etc`, { headers: { Cookie: cookie } });
  assert.match(d.headers.get('content-disposition'), /etc\.tar/);
  assert.equal(await d.text(), 'FAKE-DIRECTORY-TAR');
  assert.equal((await call('GET', `/docker/containers/${CID}/fs/download?path=/nope`)).status, 400);
});

test('container fs: upload builds a valid one-file tar; refuses overwrite; validates names', async () => {
  const up = await fetch(base + `/docker/containers/${CID}/fs/upload?path=/etc&name=up.txt`, { method: 'PUT', headers: { Cookie: cookie }, body: Buffer.from('payload!') });
  assert.equal(up.status, 201, await up.clone().text());
  assert.equal(dk.putPath, '/etc');
  assert.equal(dk.putTar.length, 512 + 512 + 1024);
  assert.equal(dk.putTar.toString('latin1', 0, 6), 'up.txt');
  assert.equal(dk.putTar.toString('latin1', 512, 520), 'payload!');
  const dup = await fetch(base + `/docker/containers/${CID}/fs/upload?path=/etc&name=hello.txt`, { method: 'PUT', headers: { Cookie: cookie }, body: Buffer.from('x') });
  assert.equal(dup.status, 400); // exists
  const bad = await fetch(base + `/docker/containers/${CID}/fs/upload?path=/etc&name=a%2Fb`, { method: 'PUT', headers: { Cookie: cookie }, body: Buffer.from('x') });
  assert.equal(bad.status, 400);
});

test('container fs: mkdir / rename / delete use argv commands; root is protected', async () => {
  assert.equal((await call('POST', `/docker/containers/${CID}/fs/mkdir`, { path: '/data', name: 'new dir' })).status, 201);
  assert.deepEqual(dk.lastCmd, ['mkdir', '--', '/data/new dir']);
  assert.equal((await call('POST', `/docker/containers/${CID}/fs/rename`, { path: '/data/a', newName: 'b' })).status, 200);
  assert.deepEqual(dk.lastCmd, ['mv', '--', '/data/a', '/data/b']);
  assert.equal((await call('DELETE', `/docker/containers/${CID}/fs?path=/data/old`)).status, 200);
  assert.deepEqual(dk.lastCmd, ['rm', '-rf', '--', '/data/old']);
  assert.equal((await call('DELETE', `/docker/containers/${CID}/fs?path=/`)).status, 400);
  assert.equal((await call('DELETE', `/docker/containers/${CID}/fs?path=/../..`)).status, 400); // normalises to /
  assert.equal((await call('POST', `/docker/containers/${CID}/fs/rename`, { path: '/a', newName: '../x' })).status, 400);
  assert.equal((await call('GET', `/docker/containers/${CID}/fs/list`, null, userCookie)).status, 403);
});

// ---------------- terminal (WebSocket) ----------------
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
