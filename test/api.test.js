import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// --- fake Caddy admin API: records last /load body, can be told to reject ---
const fake = { last: null, reject: false, calls: 0 };
const caddy = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url === '/config/apps' && req.method === 'POST') {
      fake.calls++;
      if (fake.reject) { res.writeHead(400); return res.end('bad config'); }
      fake.last = { apps: JSON.parse(b) }; res.writeHead(200); return res.end();
    }
    if (req.url === '/config/') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(fake.last || {})); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => caddy.listen(0, '127.0.0.1', r));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadm-'));
process.env.DATA_DIR = dataDir;
process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${caddy.address().port}`;
process.env.ADMIN_EMAIL = 'admin@test.io';
process.env.ADMIN_PASSWORD = 'secret-pass-1';
const ENV_TOKEN = 'ci-static-token-' + 'x'.repeat(20);
process.env.CERT_ASK_TOKEN = ENV_TOKEN;

const { createApp } = await import('../src/server.js');
const { bootstrapAdmin } = await import('../src/auth.js');
const { db } = await import('../src/db.js');
await bootstrapAdmin();

let base, server, cookie = '';
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); caddy.close(); db.close(); });

async function call(method, url, body, ck = cookie) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(ck && { Cookie: ck }) }, body: body && JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: sc?.split(';')[0] };
}

test('requires auth', async () => {
  assert.equal((await call('GET', '/hosts', null, '')).status, 401);
});

test('login rejects bad password, accepts good one', async () => {
  assert.equal((await call('POST', '/login', { email: 'admin@test.io', password: 'nope' }, '')).status, 401);
  const r = await call('POST', '/login', { email: 'admin@test.io', password: 'secret-pass-1' }, '');
  assert.equal(r.status, 200);
  cookie = r.cookie;
});

test('validation errors', async () => {
  const r = await call('POST', '/hosts', { domains: 'not a domain!', forward_host: '127.0.0.1', forward_port: 80 });
  assert.equal(r.status, 400);
});

test('letsencrypt host builds http+https servers with redirect, acme policy, hsts', async () => {
  const r = await call('POST', '/hosts', {
    domains: 'App.Example.com', forward_host: '10.0.0.5', forward_port: 3000,
    ssl_mode: 'letsencrypt', force_ssl: true, hsts: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.applied, true);
  const cfg = fake.last;
  const srv = cfg.apps.http.servers;
  assert.deepEqual(srv.srv_https.routes[0].match[0].host, ['app.example.com']);
  assert.equal(srv.srv_https.routes[0].handle[0].handler, 'headers');
  assert.equal(srv.srv_http.routes[0].handle[0].status_code, 308);
  assert.equal(cfg.apps.tls.automation.policies[0].issuers[0].module, 'acme');
  assert.equal(srv.srv_https.routes[0].handle[1].upstreams[0].dial, '10.0.0.5:3000');
});

test('duplicate domain rejected', async () => {
  const r = await call('POST', '/hosts', { domains: 'app.example.com', forward_host: 'x', forward_port: 1 });
  assert.equal(r.status, 400);
});

test('caddy rejecting config rolls the DB change back', async () => {
  fake.reject = true;
  const r = await call('POST', '/hosts', { domains: 'rollback.example.com', forward_host: 'x', forward_port: 1 });
  fake.reject = false;
  assert.equal(r.status, 422);
  const list = await call('GET', '/hosts');
  assert.ok(!list.body.some((h) => h.domains.includes('rollback.example.com')));
});

test('http-only host skips auto https', async () => {
  const r = await call('POST', '/hosts', { domains: 'plain.example.com', forward_host: 'x', forward_port: 8080 });
  assert.equal(r.status, 201);
  assert.deepEqual(fake.last.apps.http.servers.srv_http.automatic_https.skip, ['plain.example.com']);
});

test('custom certificate: validated, loaded into tls app, protected while in use', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const keyF = path.join(tmp, 'k.pem'), crtF = path.join(tmp, 'c.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyF, '-out', crtF,
      '-days', '30', '-subj', '/CN=secure.example.com', '-addext', 'subjectAltName=DNS:secure.example.com,DNS:*.wild.example.com'], { stdio: 'ignore' });
  } catch { return; } // openssl not available -> skip
  const certificate = fs.readFileSync(crtF, 'utf8'), private_key = fs.readFileSync(keyF, 'utf8');

  const bad = await call('POST', '/certificates', { name: 'x', certificate, private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.equal(bad.status, 400); // key mismatch

  const ok = await call('POST', '/certificates', { name: 'test cert', certificate, private_key });
  assert.equal(ok.status, 201);
  assert.ok(!('key_pem' in ok.body) && !JSON.stringify(ok.body).includes('PRIVATE'));

  const wrong = await call('POST', '/hosts', { domains: 'other.example.com', forward_host: 'x', forward_port: 1, ssl_mode: 'custom', certificate_id: ok.body.id });
  assert.equal(wrong.status, 400); // cert doesn't cover domain

  const host = await call('POST', '/hosts', { domains: 'secure.example.com, a.wild.example.com', forward_host: 'x', forward_port: 1, ssl_mode: 'custom', certificate_id: ok.body.id });
  assert.equal(host.status, 201);
  assert.equal(fake.last.apps.tls.certificates.load_pem.length, 1);
  assert.ok(fake.last.apps.http.servers.srv_https.automatic_https.skip_certificates.includes('secure.example.com'));

  assert.equal((await call('DELETE', `/certificates/${ok.body.id}`)).status, 400); // in use
});

test('users: non-admin forbidden, last admin protected', async () => {
  const created = await call('POST', '/users', { email: 'u@test.io', password: 'password-123', role: 'user' });
  assert.equal(created.status, 201);
  const login = await call('POST', '/login', { email: 'u@test.io', password: 'password-123' }, '');
  assert.equal((await call('GET', '/users', null, login.cookie)).status, 403);
  assert.equal((await call('DELETE', '/users/1')).status, 400); // cannot delete self / last admin
});

test('status endpoint and monitoring stats', async () => {
  assert.equal((await call('GET', '/settings/caddy')).body.reachable, true);
  const s = await call('GET', '/system');
  assert.ok(s.body.memory.total > 0);
});

// ---------------- API tokens for CI ----------------
async function bearer(token, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('tokens: admin creates, token shown once, stored hashed', async () => {
  const r = await call('POST', '/tokens', { name: 'github-ci', scope: 'write', expires_days: 30 });
  assert.equal(r.status, 201);
  assert.match(r.body.token, /^cat_/);
  globalThis.ciToken = r.body.token;
  const list = await call('GET', '/tokens');
  assert.equal(list.body.env_token_enabled, true);
  assert.ok(!JSON.stringify(list.body).includes(r.body.token));
  assert.ok(!db.prepare('SELECT token_hash FROM api_tokens').all().some((x) => x.token_hash === r.body.token));
});

test('tokens: CI creates a Lets Encrypt host idempotently by domain', async () => {
  const body = { forward_host: '10.1.1.1', forward_port: 8080, ssl_mode: 'letsencrypt', force_ssl: true };
  const a = await bearer(globalThis.ciToken, 'PUT', '/hosts/by-domain/ci.example.com', body);
  assert.equal(a.status, 201); assert.equal(a.body.created, true); assert.equal(a.body.applied, true);
  assert.equal(fake.last.apps.tls.automation.policies.at(-1).issuers[0].module, 'acme');
  // second deploy: same call updates in place, omitted fields kept
  const b = await bearer(globalThis.ciToken, 'PUT', '/hosts/by-domain/ci.example.com', { forward_port: 9090 });
  assert.equal(b.status, 200); assert.equal(b.body.created, false);
  assert.equal(b.body.id, a.body.id); assert.equal(b.body.forward_port, 9090);
  assert.equal(b.body.ssl_mode, 'letsencrypt'); assert.equal(b.body.forward_host, '10.1.1.1');
  const all = await call('GET', '/hosts');
  assert.equal(all.body.filter((h) => h.domains.includes('ci.example.com')).length, 1);
});

test('tokens: ssl-status?wait reports not ready (nothing serving TLS here) without hanging', async () => {
  const id = (await call('GET', '/hosts')).body.find((h) => h.domains.includes('ci.example.com')).id;
  const t0 = Date.now();
  const r = await bearer(globalThis.ciToken, 'GET', `/hosts/${id}/ssl-status?wait=1`);
  assert.equal(r.status, 200); assert.equal(r.body.ready, false);
  assert.ok(Date.now() - t0 < 8000);
});

test('tokens: confined to hosts/certificates - no users, docker, files, settings, tokens', async () => {
  for (const u of ['/users', '/docker/containers', '/files/roots', '/settings', '/tokens', '/me', '/system']) {
    assert.equal((await bearer(globalThis.ciToken, 'GET', u)).status, 403, u);
  }
  assert.equal((await bearer(globalThis.ciToken, 'POST', '/tokens', { name: 'x' })).status, 403);
});

test('tokens: read scope cannot write; bad / missing / env token', async () => {
  const ro = (await call('POST', '/tokens', { name: 'viewer', scope: 'read' })).body.token;
  assert.equal((await bearer(ro, 'GET', '/hosts')).status, 200);
  assert.equal((await bearer(ro, 'PUT', '/hosts/by-domain/nope.example.com', { forward_host: 'x', forward_port: 1 })).status, 403);
  assert.equal((await bearer('cat_wrong', 'GET', '/hosts')).status, 401);
  assert.equal((await bearer(null, 'GET', '/hosts')).status, 401);
  // static CERT_ASK_TOKEN from .env
  const e = await bearer(ENV_TOKEN, 'PUT', '/hosts/by-domain/env.example.com', { forward_host: 'x', forward_port: 1 });
  assert.equal(e.status, 201);
  assert.equal((await bearer(ENV_TOKEN, 'GET', '/users')).status, 403);
});

test('tokens: token actions are audited; revoking stops access', async () => {
  const audit = db.prepare("SELECT detail FROM audit_log WHERE action='api_token'").all();
  assert.ok(audit.some((a) => a.detail.includes('token:github-ci') && a.detail.includes('PUT /api/hosts/by-domain/ci.example.com') || a.detail.includes('by-domain/ci.example.com')));
  const id = (await call('GET', '/tokens')).body.tokens.find((t) => t.name === 'github-ci').id;
  assert.equal((await call('DELETE', `/tokens/${id}`)).status, 200);
  assert.equal((await bearer(globalThis.ciToken, 'GET', '/hosts')).status, 401);
});

test('tokens: expired token rejected', async () => {
  const { token, id } = await (async () => { const r = (await call('POST', '/tokens', { name: 'short', scope: 'write', expires_days: 1 })).body; return r; })();
  db.prepare("UPDATE api_tokens SET expires_at = datetime('now','-1 minute') WHERE id=?").run(id);
  assert.equal((await bearer(token, 'GET', '/hosts')).status, 401);
});
