import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---- fake Docker engine on a unix socket / named pipe ----
const SELF = (os.hostname() + 'f'.repeat(64)).slice(0, 64);
const OTHER = 'a'.repeat(64);
const dk = { calls: [], createAttempts: 0 };
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
    if (u.endsWith('/json') && u.startsWith('/containers/')) return json({ Config: { Tty: false } });
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
const { bootstrapAdmin } = await import('../src/auth.js');
const { db } = await import('../src/db.js');
await bootstrapAdmin();

let base, server, cookie, userCookie;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const login = (email, password) => fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  cookie = (await login('admin@test.io', 'secret-pass-1')).headers.get('set-cookie').split(';')[0];
  await call('POST', '/users', { email: 'u@test.io', password: 'password-123', role: 'user' });
  userCookie = (await login('u@test.io', 'password-123')).headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); fakeDocker.close(); db.close(); });

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
