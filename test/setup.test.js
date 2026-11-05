import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const fake = { last: null, reject: false };
const caddy = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url === '/config/apps' && req.method === 'POST') {
      if (fake.reject) { res.writeHead(400); return res.end('bad'); }
      fake.last = { apps: JSON.parse(b) }; res.writeHead(200); return res.end();
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => caddy.listen(0, '127.0.0.1', r));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cads-'));
process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${caddy.address().port}`;
process.env.SETUP_TOKEN = 'setup-token-for-tests';
process.env.PANEL_UPSTREAM = 'panel:8181';
delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD;

const { createApp } = await import('../src/server.js');
const { bootstrapAdmin } = await import('../src/auth.js');
const { db } = await import('../src/db.js');
assert.equal(await bootstrapAdmin(), null); // no env credentials -> browser setup

let base, server, cookie = '';
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); caddy.close(); db.close(); });

async function call(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => ({})), setCookie: sc };
}

test('fresh install needs setup; nothing else works yet', async () => {
  assert.equal((await call('GET', '/setup/status')).body.needsSetup, true);
  assert.equal((await call('GET', '/hosts')).status, 401);
  assert.equal((await call('POST', '/login', { email: 'x@y.io', password: 'whatever1' })).status, 401);
});

test('setup rejects a wrong token and weak input', async () => {
  const ok = { email: 'boss@example.com', password: 'a-strong-pass', name: 'Boss' };
  assert.equal((await call('POST', '/setup', { ...ok, token: 'nope' })).status, 403);
  assert.equal((await call('POST', '/setup', { ...ok, token: 'setup-token-for-tests', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/setup', { ...ok, token: 'setup-token-for-tests', email: 'not-an-email' })).status, 400);
  assert.equal((await call('GET', '/setup/status')).body.needsSetup, true);
});

test('setup with an invalid panel domain rolls back: no admin is created', async () => {
  const r = await call('POST', '/setup', { token: 'setup-token-for-tests', email: 'boss@example.com', password: 'a-strong-pass', panel_domain: 'bad domain!' });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 0);
});

test('setup creates the chosen admin + panel domain, logs in, then locks itself', async () => {
  const r = await call('POST', '/setup', {
    token: 'setup-token-for-tests', email: 'boss@example.com', name: 'Boss', password: 'a-strong-pass',
    panel_domain: 'HTTPS://Panel.Example.com/', ssl_mode: 'letsencrypt', force_ssl: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'admin');
  assert.equal(r.body.applied, true);
  cookie = r.setCookie.split(';')[0];
  assert.equal((await call('GET', '/me')).body.email, 'boss@example.com');
  assert.equal((await call('GET', '/setup/status')).body.needsSetup, false);
  assert.equal((await call('POST', '/setup', { token: 'setup-token-for-tests', email: 'evil@example.com', password: 'a-strong-pass' })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
  // ACME email defaults to the admin email (expiry notices)
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='acme_email'").get().value, 'boss@example.com');
});

test('panel domain is served by Caddy: https route to the panel upstream, ACME policy, http->https redirect', () => {
  const srv = fake.last.apps.http.servers;
  assert.deepEqual(srv.srv_https.routes[0].match[0].host, ['panel.example.com']);
  assert.equal(srv.srv_https.routes[0].handle.at(-1).upstreams[0].dial, 'panel:8181');
  assert.equal(srv.srv_http.routes[0].handle[0].status_code, 308);
  const pol = fake.last.apps.tls.automation.policies[0];
  assert.deepEqual(pol.subjects, ['panel.example.com']);
  assert.equal(pol.issuers[0].email, 'boss@example.com');
});

test('panel domain settings: read, conflicts both ways, caddy rejection rolls back, remove', async () => {
  const s = (await call('GET', '/settings/panel-domain')).body;
  assert.equal(s.domain, 'panel.example.com'); assert.equal(s.url, 'https://panel.example.com');

  // a proxy host may not steal the panel's domain
  assert.equal((await call('POST', '/hosts', { domains: 'panel.example.com', forward_host: 'x', forward_port: 1 })).status, 400);
  // ...and the panel may not take a proxied host's domain
  assert.equal((await call('POST', '/hosts', { domains: 'app.example.com', forward_host: 'x', forward_port: 1 })).status, 201);
  assert.equal((await call('PUT', '/settings/panel-domain', { domain: 'app.example.com' })).status, 400);
  assert.equal((await call('PUT', '/settings/panel-domain', { domain: '*.example.com' })).status, 400);

  // Caddy refuses the new config -> setting not changed
  fake.reject = true;
  assert.equal((await call('PUT', '/settings/panel-domain', { domain: 'admin.example.com', ssl_mode: 'internal' })).status, 422);
  fake.reject = false;
  assert.equal((await call('GET', '/settings/panel-domain')).body.domain, 'panel.example.com');

  // move it to another subdomain without SSL, then clear it
  const moved = await call('PUT', '/settings/panel-domain', { domain: 'admin.example.com', ssl_mode: 'none' });
  assert.equal(moved.body.url, 'http://admin.example.com'); assert.equal(moved.body.applied, true);
  assert.ok(fake.last.apps.http.servers.srv_http.routes.some((r) => r.match[0].host[0] === 'admin.example.com'));
  const cleared = await call('DELETE', '/settings/panel-domain');
  assert.equal(cleared.body.domain, '');
  assert.ok(!JSON.stringify(fake.last).includes('admin.example.com'));
});

test('API tokens cannot change the panel domain', async () => {
  const t = (await call('POST', '/tokens', { name: 'ci', scope: 'write' })).body.token;
  const r = await fetch(base + '/settings/panel-domain', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ domain: 'evil.example.com' }) });
  assert.equal(r.status, 403);
});

test('session cookie gets Secure automatically behind Caddy (X-Forwarded-Proto: https)', async () => {
  const creds = JSON.stringify({ email: 'boss@example.com', password: 'a-strong-pass' });
  const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: creds });
  assert.match(r.headers.get('set-cookie'), /; Secure/);
  const plain = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: creds });
  assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/);
});

test('domains: a pasted URL is reduced to the bare host name (hosts and panel domain)', async () => {
  const r = await call('POST', '/hosts', { domains: 'https://Web.Example.com/some/path?x=1', forward_host: 'x', forward_port: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.domains, ['web.example.com']);
  assert.equal((await call('POST', '/hosts', { domains: 'bad host name', forward_host: 'x', forward_port: 1 })).status, 400);
  assert.equal((await call('POST', '/hosts', { domains: 'host.example.com:8080', forward_host: 'x', forward_port: 1 })).status, 400); // a port is not part of a domain
});
