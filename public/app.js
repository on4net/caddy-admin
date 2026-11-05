// Minimal dependency-free SPA. All text goes through textContent (no innerHTML) -> no XSS.
const $app = document.getElementById('app');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

async function api(method, url, body) {
  const r = await fetch('/api' + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  // '/me' is the login probe inside render(): re-rendering on its 401 would loop forever
  if (r.status === 401 && url !== '/login' && url !== '/me') { state.user = null; render(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const state = { notice: null, user: null, page: 'dashboard', dockerTab: 'containers', files: { root: null, path: '/', container: null }, timer: null };
const pages = {
  dashboard: ['Dashboard', dashboard], monitor: ['Monitoring', monitorPage],
  docker: ['Docker', dockerPage, true], files: ['Files', filesPage, true],
  hosts: ['Proxy Hosts', hostsPage], certs: ['SSL Certificates', certsPage],
  users: ['Users', usersPage, true], settings: ['Settings', settingsPage],
};

const flash = (kind, text) => h('div', { class: `msg ${kind}` }, text);
const fmtDate = (s) => (s ? s.slice(0, 10) : '-');
const toast = (box, kind, text) => { box.replaceChildren(flash(kind, text)); };
const applyNote = (r) => (r.applied === false ? `Saved, but Caddy was not updated: ${r.warning}` : null);

async function render() {
  clearInterval(state.timer);
  if (!state.user) {
    try { state.user = await api('GET', '/me'); }
    catch {
      const st = await fetch('/api/setup/status').then((r) => r.json()).catch(() => ({}));
      return st.needsSetup ? setupView() : loginView();
    }
  }
  const nav = h('nav', null, Object.entries(pages)
    .filter(([, p]) => !p[2] || state.user.role === 'admin')
    .map(([k, p]) => h('a', { class: state.page === k ? 'on' : '', onclick: () => { state.page = k; render(); } }, p[0])));
  const main = h('main');
  $app.replaceChildren(
    h('header', null, h('b', null, 'Caddy Admin'), nav,
      h('span', { class: 'mut' }, state.user.email),
      h('button', { onclick: async () => { await api('POST', '/logout'); state.user = null; render(); } }, 'Logout')),
    main);
  try { await pages[state.page][1](main); } catch (e) { main.replaceChildren(flash('err', e.message)); }
  if (state.notice) { main.prepend(flash(state.notice.kind, state.notice.text)); state.notice = null; }
}

// ---------- first-run setup ----------
function setupView() {
  const msg = h('div');
  const f = {
    token: h('input', { required: true, autocomplete: 'off', placeholder: 'printed in the panel log' }),
    email: h('input', { type: 'email', required: true, autocomplete: 'username' }), name: h('input', { placeholder: 'Administrator' }),
    pw: h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), pw2: h('input', { type: 'password', required: true, autocomplete: 'new-password' }),
    domain: h('input', { placeholder: 'panel.example.com (optional)' }),
    ssl: h('select', null, [['letsencrypt', "Let's Encrypt (public domain)"], ['internal', 'Internal CA (LAN)'], ['none', 'No SSL (HTTP)']].map(([k, t]) => h('option', { value: k }, t))),
  };
  $app.replaceChildren(h('form', {
    class: 'card login', style: 'max-width:460px', onsubmit: async (e) => {
      e.preventDefault();
      if (f.pw.value !== f.pw2.value) return toast(msg, 'err', 'Passwords do not match');
      try {
        const r = await api('POST', '/setup', {
          token: f.token.value.trim(), email: f.email.value, name: f.name.value, password: f.pw.value,
          panel_domain: f.domain.value.trim() || undefined, ssl_mode: f.ssl.value,
        });
        state.user = r.user;
        if (f.domain.value.trim()) {
          state.notice = r.applied
            ? { kind: 'ok', text: `Panel domain set: ${f.ssl.value === 'none' ? 'http' : 'https'}://${f.domain.value.trim()} - make sure its DNS points to this server (ports 80/443). Check status in Settings.` }
            : { kind: 'warn', text: `Admin created, but Caddy was not updated: ${r.warning}. Set the domain again in Settings once Caddy is running.` };
        }
        render();
      } catch (err) { toast(msg, 'err', err.message); }
    },
  }, h('h2', null, 'Welcome - set up Caddy Admin'), msg,
  h('p', { class: 'mut' }, 'Create the administrator account. The setup token is in the panel log: docker compose logs panel'),
  h('label', null, 'Setup token'), f.token, h('label', null, 'Admin email'), f.email, h('label', null, 'Name (optional)'), f.name,
  h('div', { class: 'grid' }, h('div', null, h('label', null, 'Password (min 8)'), f.pw), h('div', null, h('label', null, 'Repeat password'), f.pw2)),
  h('h2', { style: 'margin-top:1.4rem' }, 'Panel address (optional)'),
  h('p', { class: 'mut' }, 'Serve this panel on its own domain or subdomain. You can also do it later in Settings.'),
  h('label', null, 'Domain / subdomain'), f.domain, h('label', null, 'SSL'), f.ssl,
  h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri', style: 'width:100%' }, 'Create admin'))));
}

function loginView() {
  const msg = h('div');
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  $app.replaceChildren(h('form', {
    class: 'card login', onsubmit: async (e) => {
      e.preventDefault();
      try { state.user = await api('POST', '/login', { email: email.value, password: pw.value }); render(); }
      catch (err) { toast(msg, 'err', err.message); }
    },
  }, h('h2', null, 'Caddy Admin'), msg, h('label', null, 'Email'), email, h('label', null, 'Password'), pw,
  h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri', style: 'width:100%' }, 'Sign in'))));
}

// ---------- Dashboard (Caddy status + server stats; extend with monitoring modules) ----------
async function dashboard(main) {
  const [caddy, sys, hs] = await Promise.all([api('GET', '/settings/caddy'), api('GET', '/system'), api('GET', '/hosts')]);
  const stat = (label, value, pct) => h('div', { class: 'card stat' }, h('div', { class: 'mut' }, label), h('div', { class: 'v' }, value),
    pct != null && h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })));
  const gb = (b) => (b / 1073741824).toFixed(1) + ' GB';
  main.replaceChildren(
    h('div', { class: 'card row sp' }, h('div', null, 'Caddy: ',
      h('span', { class: `badge ${caddy.reachable ? 'ok' : 'bad'}` }, caddy.reachable ? 'running' : 'unreachable'),
      !caddy.reachable && h('div', { class: 'mut' }, caddy.error)),
    h('div', { class: 'mut' }, `${hs.filter((x) => x.enabled).length}/${hs.length} hosts enabled`)),
    h('div', { class: 'row' },
      stat('CPU', sys.cpuPercent + '%', sys.cpuPercent),
      stat('Memory', `${gb(sys.memory.used)} / ${gb(sys.memory.total)}`, sys.memory.percent),
      stat('Uptime', `${Math.floor(sys.uptimeSec / 3600)}h`)),
    h('div', { class: 'card mut' }, `${sys.hostname} - ${sys.platform} - ${sys.cpuCount} CPU`));
}

// ---------- Proxy hosts ----------
async function hostsPage(main) {
  const [list, certs] = await Promise.all([api('GET', '/hosts'), api('GET', '/certificates')]);
  const msg = h('div');
  const sslBadge = (x) => h('span', { class: `badge ${x.ssl_mode === 'none' ? '' : 'ok'}` },
    { none: 'No SSL', letsencrypt: "Let's Encrypt", internal: 'Internal CA', custom: 'Custom' }[x.ssl_mode]);
  const act = async (fn) => {
    try {
      const r = await fn(); const n = r && applyNote(r);
      await render();
      if (n) $app.querySelector('main')?.prepend(flash('warn', n));
    }
    catch (e) { toast(msg, 'err', e.message); }
  };
  main.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', null, 'Proxy Hosts'), h('button', { class: 'pri', onclick: () => hostDialog(null, certs, act) }, '+ Add host')),
    msg,
    h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, ['Domains', 'Forwards to', 'SSL', 'Status', ''].map((c) => h('th', null, c)))),
      h('tbody', null, list.map((x) => h('tr', null,
        h('td', null, x.domains.join(', ')),
        h('td', null, `${x.forward_scheme}://${x.forward_host}:${x.forward_port}`),
        h('td', null, sslBadge(x), x.force_ssl ? ' ' : '', x.force_ssl ? h('span', { class: 'badge' }, 'forced') : ''),
        h('td', null, h('span', { class: `badge ${x.enabled ? 'ok' : 'warn'}` }, x.enabled ? 'enabled' : 'disabled')),
        h('td', { class: 'row' },
          x.ssl_mode !== 'none' && h('button', { onclick: () => sslDialog(x) }, 'SSL status'),
          h('button', { onclick: () => act(() => api('POST', `/hosts/${x.id}/toggle`)) }, x.enabled ? 'Disable' : 'Enable'),
          h('button', { onclick: () => hostDialog(x, certs, act) }, 'Edit'),
          h('button', { class: 'bad', onclick: () => confirmDo(`Delete ${x.domains[0]}?`, () => act(() => api('DELETE', `/hosts/${x.id}`))) }, 'Delete')))),
      list.length === 0 && h('tr', null, h('td', { colspan: 5, class: 'mut' }, 'No hosts yet.')))))));
}

function dialog(title, body, onClose) {
  const d = h('dialog', null, h('h2', null, title), body);
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  document.body.append(d); d.showModal(); return d;
}
function confirmDo(text, fn) {
  const d = dialog('Confirm', h('div', null, h('p', null, text), h('div', { class: 'row' },
    h('button', { class: 'bad', onclick: () => { d.close(); fn(); } }, 'Yes'), h('button', { onclick: () => d.close() }, 'Cancel'))));
}

function hostDialog(x, certs, act) {
  const v = x || { domains: [], forward_scheme: 'http', forward_host: '', forward_port: 80, ssl_mode: 'none', force_ssl: 0, hsts: 0, skip_upstream_verify: 0, enabled: 1 };
  const err = h('div');
  const f = {
    domains: h('input', { value: v.domains.join(', '), placeholder: 'app.example.com, www.example.com', required: true }),
    scheme: h('select', null, ['http', 'https'].map((s) => h('option', { value: s, selected: v.forward_scheme === s }, s))),
    host: h('input', { value: v.forward_host, placeholder: '127.0.0.1 or container-name', required: true }),
    port: h('input', { type: 'number', min: 1, max: 65535, value: v.forward_port, required: true }),
    ssl: h('select', null, [['none', 'None (HTTP only)'], ['letsencrypt', "Let's Encrypt (auto, renews itself)"], ['internal', 'Internal CA (self-signed, for LAN)'], ['custom', 'Custom certificate']]
      .map(([k, t]) => h('option', { value: k, selected: v.ssl_mode === k }, t))),
    cert: h('select', null, certs.map((c) => h('option', { value: c.id, selected: v.certificate_id === c.id }, `${c.name} (${c.domains.join(', ')})`))),
    force: h('input', { type: 'checkbox', checked: !!v.force_ssl }), hsts: h('input', { type: 'checkbox', checked: !!v.hsts }),
    skip: h('input', { type: 'checkbox', checked: !!v.skip_upstream_verify }),
  };
  const sslOnly = h('div'); const certRow = h('div');
  const sync = () => {
    sslOnly.hidden = f.ssl.value === 'none'; certRow.hidden = f.ssl.value !== 'custom';
  };
  f.ssl.addEventListener('change', sync);
  sslOnly.append(h('label', { class: 'ck' }, f.force, 'Force SSL (redirect HTTP to HTTPS)'), h('label', { class: 'ck' }, f.hsts, 'HSTS'));
  certRow.append(h('label', null, 'Certificate'), f.cert, certs.length ? '' : h('div', { class: 'mut' }, 'Upload a certificate first (SSL Certificates tab).'));
  const d = dialog(x ? 'Edit host' : 'Add host', h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const body = {
        domains: f.domains.value, forward_scheme: f.scheme.value, forward_host: f.host.value, forward_port: Number(f.port.value),
        ssl_mode: f.ssl.value, certificate_id: f.ssl.value === 'custom' ? Number(f.cert.value) : null,
        force_ssl: f.force.checked, hsts: f.hsts.checked, skip_upstream_verify: f.skip.checked, enabled: v.enabled === 1,
      };
      try { d.close(); await act(() => api(x ? 'PUT' : 'POST', x ? `/hosts/${x.id}` : '/hosts', body)); }
      catch (e2) { toast(err, 'err', e2.message); }
    },
  }, err, h('label', null, 'Domain names (comma separated)'), f.domains,
  h('div', { class: 'grid' }, h('div', null, h('label', null, 'Scheme'), f.scheme), h('div', null, h('label', null, 'Forward host'), f.host), h('div', null, h('label', null, 'Port'), f.port)),
  h('label', { class: 'ck' }, f.skip, 'Skip upstream certificate verification (https upstream, self-signed)'),
  h('label', null, 'SSL'), f.ssl, certRow, sslOnly,
  h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Save'), h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
  sync();
}

async function sslDialog(x) {
  const body = h('div', { class: 'mut' }, 'Checking what Caddy serves...');
  const d = dialog(`SSL status - ${x.domains[0]}`, h('div', null, body, h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { onclick: () => d.close() }, 'Close'))));
  try {
    const r = await api('GET', `/hosts/${x.id}/ssl-status`);
    body.replaceChildren(...r.domains.map((s) => h('div', { class: 'card' }, h('b', null, s.domain), ' ',
      s.ok ? [h('span', { class: `badge ${s.daysLeft > 14 ? 'ok' : 'warn'}` }, `${s.daysLeft} days left`),
        h('div', { class: 'mut' }, `Issuer: ${s.issuer || '?'} - expires ${fmtDate(s.expiresAt)}${s.trusted ? '' : ' - not publicly trusted (expected for internal/self-signed, or still being issued)'}`)]
        : [h('span', { class: 'badge bad' }, 'no certificate'), h('div', { class: 'mut' }, `${s.error}. Caddy may still be issuing it - check DNS points here and ports 80/443 are open.`)])));
    if (!r.domains.length) body.replaceChildren('Wildcard domains cannot be probed.');
  } catch (e) { body.replaceChildren(flash('err', e.message)); }
}

// ---------- Certificates ----------
async function certsPage(main) {
  const list = await api('GET', '/certificates');
  const msg = h('div');
  main.replaceChildren(
    h('div', { class: 'card' }, h('h2', null, 'Custom certificates'),
      h('p', { class: 'mut' }, "Let's Encrypt and internal certificates need no upload: choose them on a proxy host and Caddy issues and renews them automatically."),
      msg,
      h('div', { class: 'tw' }, h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Domains', 'Expires', 'In use', ''].map((c) => h('th', null, c)))),
        h('tbody', null, list.map((c) => h('tr', null, h('td', null, c.name), h('td', null, c.domains.join(', ')),
          h('td', null, fmtDate(c.expires_at), ' ', h('span', { class: `badge ${c.daysLeft > 14 ? 'ok' : 'warn'}` }, `${c.daysLeft}d`)),
          h('td', null, c.in_use), h('td', null, h('button', { class: 'bad', disabled: c.in_use > 0, onclick: () => confirmDo(`Delete ${c.name}?`, async () => { try { await api('DELETE', `/certificates/${c.id}`); render(); } catch (e) { toast(msg, 'err', e.message); } }) }, 'Delete')))),
        list.length === 0 && h('tr', null, h('td', { colspan: 5, class: 'mut' }, 'None uploaded.')))))),
    uploadForm(msg));
}
function uploadForm(msg) {
  const name = h('input', { required: true }), cert = h('textarea', { required: true, placeholder: '-----BEGIN CERTIFICATE----- (full chain)' }),
    key = h('textarea', { required: true, placeholder: '-----BEGIN PRIVATE KEY-----' });
  return h('form', {
    class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/certificates', { name: name.value, certificate: cert.value, private_key: key.value }); render(); }
      catch (err) { toast(msg, 'err', err.message); }
    },
  }, h('h2', null, 'Upload certificate'), h('label', null, 'Name'), name, h('label', null, 'Certificate (PEM)'), cert, h('label', null, 'Private key (PEM, unencrypted)'), key,
  h('div', { style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Upload')));
}

// ---------- Users ----------
async function usersPage(main) {
  const list = await api('GET', '/users');
  const msg = h('div');
  const run = async (fn) => { try { await fn(); render(); } catch (e) { toast(msg, 'err', e.message); } };
  const email = h('input', { type: 'email', required: true }), name = h('input'), pw = h('input', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
    role = h('select', null, h('option', { value: 'user' }, 'user'), h('option', { value: 'admin' }, 'admin'));
  main.replaceChildren(
    h('div', { class: 'card' }, h('h2', null, 'Users'), msg, h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, ['Email', 'Name', 'Role', 'Status', ''].map((c) => h('th', null, c)))),
      h('tbody', null, list.map((u) => h('tr', null, h('td', null, u.email), h('td', null, u.name), h('td', null, u.role),
        h('td', null, h('span', { class: `badge ${u.disabled ? 'warn' : 'ok'}` }, u.disabled ? 'disabled' : 'active')),
        h('td', { class: 'row' },
          h('button', { onclick: () => run(() => api('PUT', `/users/${u.id}`, { disabled: !u.disabled })) }, u.disabled ? 'Enable' : 'Disable'),
          h('button', { class: 'bad', onclick: () => confirmDo(`Delete ${u.email}?`, () => run(() => api('DELETE', `/users/${u.id}`))) }, 'Delete')))))))),
    h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); run(() => api('POST', '/users', { email: email.value, name: name.value, password: pw.value, role: role.value })); } },
      h('h2', null, 'Add user'), h('div', { class: 'grid' }, h('div', null, h('label', null, 'Email'), email), h('div', null, h('label', null, 'Name'), name),
        h('div', null, h('label', null, 'Password (min 8)'), pw), h('div', null, h('label', null, 'Role'), role)),
      h('div', { style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Create'))));
}

// ---------- Settings ----------
async function settingsPage(main) {
  const [s, caddy] = await Promise.all([api('GET', '/settings'), api('GET', '/settings/caddy')]);
  const isAdmin = state.user.role === 'admin';
  const msg = h('div');
  const email = h('input', { type: 'email', value: s.acme_email, placeholder: 'you@example.com', disabled: !isAdmin });
  const ca = h('input', { value: s.acme_ca, placeholder: 'default: Let\'s Encrypt production (use staging URL while testing)', disabled: !isAdmin });
  const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' }), np = h('input', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' });
  const pmsg = h('div');
  main.replaceChildren(
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await api('PUT', '/settings', { acme_email: email.value, acme_ca: ca.value }); toast(msg, r.applied ? 'ok' : 'warn', r.applied ? 'Saved and applied.' : applyNote(r)); }
      catch (err) { toast(msg, 'err', err.message); }
    } }, h('h2', null, 'SSL / ACME'), msg,
    h('label', null, "Let's Encrypt account email (expiry notices)"), email, h('label', null, 'ACME CA URL (optional)'), ca,
    isAdmin && h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Save'),
      h('button', { type: 'button', onclick: async () => { try { await api('POST', '/settings/sync'); toast(msg, 'ok', 'Caddy synced.'); } catch (err) { toast(msg, 'err', err.message); } } }, 'Re-sync Caddy'),
      h('span', { class: 'mut' }, caddy.reachable ? `Caddy reachable (${caddy.servers.join(', ') || 'no servers'})` : 'Caddy unreachable'))),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/me/password', { current: cur.value, password: np.value }); toast(pmsg, 'ok', 'Password changed.'); cur.value = np.value = ''; }
      catch (err) { toast(pmsg, 'err', err.message); }
    } }, h('h2', null, 'Change my password'), pmsg, h('label', null, 'Current password'), cur, h('label', null, 'New password'), np,
    h('div', { style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Change'))),
    isAdmin && await panelDomainCard(),
    isAdmin && await tokensCard(),
    isAdmin && await auditCard());
}
async function auditCard() {
  const rows = await api('GET', '/settings/audit');
  return h('div', { class: 'card' }, h('h2', null, 'Recent activity'), h('div', { class: 'tw' }, h('table', null,
    h('tbody', null, rows.map((r) => h('tr', null, h('td', { class: 'mut' }, r.at), h('td', null, r.email || '-'), h('td', null, r.action), h('td', { class: 'mut' }, r.detail || '')))))));
}

// ======================= helpers =======================
const bytes = (n) => {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const rate = (n) => `${bytes(n)}/s`;
const ago = (unix) => fmtDate(new Date(unix * 1000).toISOString());
const th = (cols) => h('thead', null, h('tr', null, cols.map((c) => h('th', null, c))));
const empty = (n, t) => h('tr', null, h('td', { colspan: n, class: 'mut' }, t));
const barColor = (p) => (p >= 90 ? 'var(--bad)' : p >= 75 ? 'var(--warn)' : 'var(--pri)');
const meter = (p) => h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, p)}%;background:${barColor(p)}` }));

function spark(values, { max, color = 'var(--pri)' } = {}) {
  const NS = 'http://www.w3.org/2000/svg', W = 300, H = 50;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'spark');
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return svg;
  const top = max ?? Math.max(1, ...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - (Math.min(v, top) / top) * (H - 2) - 1).toFixed(1)}`).join(' ');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '1.6');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line); return svg;
}

// ======================= Monitoring =======================
async function monitorPage(main) {
  const draw = async (first) => {
    const [s, hist] = await Promise.all([api('GET', '/system'), api('GET', '/system/history')]);
    const mem = s.memory, net = s.network;
    const card = (title, big, sub, pct, chart) => h('div', { class: 'card stat' }, h('div', { class: 'mut' }, title), h('div', { class: 'v' }, big),
      h('div', { class: 'mut' }, sub), pct != null && meter(pct), chart);
    const node = h('div', null,
      h('div', { class: 'row' },
        card('CPU', `${s.cpuPercent}%`, `${s.cpuCount} cores - load ${s.loadAvg.map((x) => x.toFixed(2)).join(' ')}`, s.cpuPercent, spark(hist.map((x) => x.cpu), { max: 100 })),
        card('Memory', `${mem.percent}%`, `${bytes(mem.used)} used - ${bytes(mem.free)} free of ${bytes(mem.total)}`, mem.percent, spark(hist.map((x) => x.mem), { max: 100, color: 'var(--warn)' })),
        net ? card('Network', `↓ ${rate(net.rxRate)}`, `↑ ${rate(net.txRate)} - total ↓ ${bytes(net.rxTotal)} ↑ ${bytes(net.txTotal)}`, null,
          h('div', null, spark(hist.map((x) => x.rx)), spark(hist.map((x) => x.tx), { color: 'var(--warn)' })))
          : card('Network', 'n/a', 'Not measurable on this platform (needs Linux /proc)', null)),
      h('div', { class: 'card' }, h('h2', null, 'Disks'),
        s.disks.length ? s.disks.map((d) => h('div', { style: 'margin-bottom:.9rem' },
          h('div', { class: 'row sp' }, h('b', null, d.label, ' ', h('span', { class: 'mut' }, d.path)), h('span', null, `${d.percent}%`)),
          meter(d.percent), h('div', { class: 'mut' }, `${bytes(d.used)} used - ${bytes(d.free)} free - ${bytes(d.total)} total`)))
          : h('div', { class: 'mut' }, 'No filesystems found.')),
      net && Object.keys(net.interfaces).length > 0 && h('div', { class: 'card' }, h('h2', null, 'Network interfaces'), h('div', { class: 'tw' }, h('table', null,
        th(['Interface', 'Down', 'Up', 'Total down', 'Total up']),
        h('tbody', null, Object.entries(net.interfaces).map(([n, v]) => h('tr', null, h('td', null, n), h('td', null, rate(v.rxRate || 0)), h('td', null, rate(v.txRate || 0)), h('td', null, bytes(v.rxTotal)), h('td', null, bytes(v.txTotal)))))))),
      h('div', { class: 'card mut' }, `${s.hostname} - ${s.platform} - ${s.cpuModel} - up ${Math.floor(s.uptimeSec / 86400)}d ${Math.floor((s.uptimeSec % 86400) / 3600)}h - refreshes every 3s`));
    if (first) main.replaceChildren(node); else if (state.page === 'monitor') main.replaceChildren(node);
  };
  await draw(true);
  state.timer = setInterval(() => draw(false).catch(() => {}), 3000);
}

// ======================= Docker =======================
async function dockerPage(main) {
  const tabs = ['containers', 'images', 'volumes', 'networks'];
  let info;
  try { info = await api('GET', '/docker/info'); }
  catch (e) { return main.replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Docker'), flash('err', e.message))); }
  const body = h('div');
  const head = h('div', { class: 'card row sp' },
    h('div', null, `Docker ${info.version}`, h('span', { class: 'mut' }, ` - ${info.os} - ${info.running} running / ${info.containers} containers - ${info.images} images`)),
    h('div', { class: 'row' }, tabs.map((t) => h('button', { class: state.dockerTab === t ? 'pri' : '', onclick: () => { state.dockerTab = t; render(); } }, t[0].toUpperCase() + t.slice(1)))));
  main.replaceChildren(head, body);
  await { containers: dockerContainers, images: dockerImages, volumes: dockerVolumes, networks: dockerNetworks }[state.dockerTab](body);
}

const stateBadge = (st) => h('span', { class: `badge ${st === 'running' ? 'ok' : st === 'exited' || st === 'dead' ? 'bad' : 'warn'}` }, st);

async function dockerContainers(body) {
  const list = await api('GET', '/docker/containers');
  const msg = h('div');
  const run = async (fn) => { try { await fn(); await render(); } catch (e) { toast(msg, 'err', e.message); } };
  const cells = {};
  body.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', null, 'Containers'), h('button', { class: 'pri', onclick: () => runDialog() }, '+ Run container')), msg,
    h('div', { class: 'tw' }, h('table', null, th(['Name', 'Image', 'State', 'CPU / Mem', 'Ports', '']),
      h('tbody', null, list.map((c) => {
        const live = h('td', { class: 'mut' }, c.state === 'running' ? '...' : '-'); cells[c.id] = live;
        return h('tr', null,
          h('td', null, h('b', null, c.name), c.self && h('span', { class: 'badge' }, 'this panel'), h('div', { class: 'mut' }, c.project ? `stack: ${c.project}` : c.id)),
          h('td', null, c.image), h('td', null, stateBadge(c.state), h('div', { class: 'mut' }, c.status)), live, h('td', null, c.ports || '-'),
          h('td', { class: 'row' },
            c.state !== 'running' && h('button', { onclick: () => run(() => api('POST', `/docker/containers/${c.id}/start`)) }, 'Start'),
            c.state === 'running' && !c.self && h('button', { onclick: () => run(() => api('POST', `/docker/containers/${c.id}/stop`)) }, 'Stop'),
            c.state === 'running' && !c.self && h('button', { onclick: () => run(() => api('POST', `/docker/containers/${c.id}/restart`)) }, 'Restart'),
            h('button', { onclick: () => logsDialog(c) }, 'Logs'),
            c.state === 'running' && h('button', { onclick: () => terminalDialog(c) }, 'Terminal'),
            c.state === 'running' && h('button', { onclick: () => { state.files = { root: '@c', path: '/', container: c.id }; state.page = 'files'; render(); } }, 'Files'),
            h('button', { onclick: () => detailsDialog(c) }, 'Details'),
            !c.self && h('button', { class: 'bad', onclick: () => confirmDo(`Remove container ${c.name}? (forces stop if running)`, () => run(() => api('DELETE', `/docker/containers/${c.id}?force=1`))) }, 'Remove')));
      }),
      list.length === 0 && empty(6, 'No containers.'))))));
  // live stats are slow (~1s each, parallel): fill in after the list is on screen
  api('GET', '/docker/containers/stats').then((st) => {
    for (const [id, td] of Object.entries(cells)) {
      const s = st[id]; if (s) td.replaceChildren(`${s.cpu}% / ${bytes(s.memUsed)}${s.memLimit ? ` of ${bytes(s.memLimit)}` : ''}`);
    }
  }).catch(() => {});
}

function logsDialog(c) {
  const MAX = 5000; // lines kept in the browser; the Download button gets everything
  const pre = h('pre', { class: 'logs' }, 'Loading...');
  const status = h('span', { class: 'mut' });
  const tail = h('select', null, [['100', 'last 100'], ['200', 'last 200'], ['500', 'last 500'], ['1000', 'last 1000'], ['5000', 'last 5000'], ['all', 'all (history)']]
    .map(([v, t]) => h('option', { value: v, selected: v === '200' }, t)));
  const live = h('input', { type: 'checkbox', checked: c.state === 'running' });
  const wrap = h('input', { type: 'checkbox', checked: true });
  const filter = h('input', { placeholder: 'Filter...', style: 'max-width:180px' });
  let es = null, lines = [], stick = true, queued = false;

  const draw = () => {
    queued = false;
    const f = filter.value.toLowerCase();
    pre.textContent = (f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines).join('\n') || '(no output)';
    if (stick) pre.scrollTop = pre.scrollHeight;
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  const stop = () => { es?.close(); es = null; };
  const load = async () => {
    stop(); lines = []; pre.textContent = 'Loading...'; stick = true;
    if (!live.checked) { // one-shot snapshot
      status.textContent = '';
      try { const r = await api('GET', `/docker/containers/${c.id}/logs?tail=${tail.value === 'all' ? 5000 : tail.value}`); lines = r.logs.split('\n'); draw(); }
      catch (e) { pre.textContent = e.message; }
      return;
    }
    status.textContent = 'connecting...';
    es = new EventSource(`/api/docker/containers/${c.id}/logs/stream?tail=${tail.value}`);
    es.onmessage = (ev) => {
      status.textContent = 'live';
      lines.push(...JSON.parse(ev.data));
      if (lines.length > MAX) lines.splice(0, lines.length - MAX);
      schedule();
    };
    es.addEventListener('end', () => { stop(); status.textContent = 'stream ended (container stopped?)'; schedule(); });
    es.onerror = () => { stop(); status.textContent = 'disconnected'; if (!lines.length) pre.textContent = 'Could not read logs (container removed or Docker unreachable).'; };
  };
  pre.addEventListener('scroll', () => { stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24; });
  tail.addEventListener('change', load); live.addEventListener('change', load);
  filter.addEventListener('input', schedule);
  wrap.addEventListener('change', () => { pre.style.whiteSpace = wrap.checked ? 'pre-wrap' : 'pre'; });

  const d = dialog(`Logs - ${c.name}`, h('div', null,
    h('div', { class: 'row', style: 'margin-bottom:.6rem' }, tail,
      h('label', { class: 'ck', style: 'margin:0' }, live, 'Live'), h('label', { class: 'ck', style: 'margin:0' }, wrap, 'Wrap'), filter,
      h('a', { class: 'btn', href: `/api/docker/containers/${c.id}/logs/download` }, 'Download all'),
      h('button', { onclick: () => { lines = []; draw(); } }, 'Clear'), status, h('button', { onclick: () => d.close() }, 'Close')),
    pre), stop);
  d.classList.add('wide');
  load();
}

// ======================= Terminal (xterm.js over WebSocket -> docker exec) =======================
let xtermLoading = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  xtermLoading ||= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/xterm.css' }));
    const load = (src) => new Promise((ok, bad) => { const s = h('script', { src }); s.onload = ok; s.onerror = () => bad(new Error(`Cannot load ${src}`)); document.head.append(s); });
    load('/vendor/xterm.js').then(() => load('/vendor/addon-fit.js')).then(resolve, (e) => { xtermLoading = null; reject(e); });
  });
  return xtermLoading;
}

async function terminalDialog(c) {
  const status = h('span', { class: 'mut' }, 'loading terminal...');
  const holder = h('div', { class: 'term' });
  const user = h('input', { placeholder: 'user (default: container user)', style: 'max-width:210px' });
  const shell = h('select', null, [['auto', 'shell: auto (bash/sh)'], ['sh', 'sh'], ['bash', 'bash']].map(([v, t]) => h('option', { value: v }, t)));
  let term = null, fit = null, ws = null;
  const onWinResize = () => fit?.fit();
  window.addEventListener('resize', onWinResize);
  const d = dialog(`Terminal - ${c.name}`, h('div', null,
    h('div', { class: 'row', style: 'margin-bottom:.6rem' }, user, shell,
      h('button', { class: 'pri', onclick: () => connect() }, 'Reconnect'), status, h('button', { onclick: () => d.close() }, 'Close')),
    holder), () => { window.removeEventListener('resize', onWinResize); ws?.close(); term?.dispose(); });
  d.classList.add('wide', 'termdlg');

  function connect() {
    if (!term) return;
    ws?.close(); term.reset(); fit.fit();
    const q = new URLSearchParams({ cols: term.cols, rows: term.rows, shell: shell.value });
    if (user.value.trim()) q.set('user', user.value.trim());
    status.textContent = 'connecting...';
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/docker/containers/${c.id}/exec?${q}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status.textContent = 'connected'; term.focus(); };
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data));
    ws.onclose = (ev) => { status.textContent = `closed${ev.reason ? ` (${ev.reason})` : ''}`; };
    ws.onerror = () => { status.textContent = 'connection failed (not logged in as admin, container stopped, or proxy blocks WebSocket)'; };
  }

  try { await loadXterm(); } catch (e) { status.textContent = e.message; return; }
  term = new window.Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: { background: '#0d1117' } });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit); term.open(holder);
  requestAnimationFrame(() => { fit.fit(); connect(); });
  const enc = new TextEncoder();
  term.onData((data) => { if (ws?.readyState === 1) ws.send(enc.encode(data)); }); // keystrokes = binary frames
  term.onResize(({ cols, rows }) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols, rows })); });
}

async function detailsDialog(c) {
  const body = h('div', { class: 'mut' }, 'Loading...');
  const d = dialog(`Details - ${c.name}`, h('div', null, body, h('div', { style: 'margin-top:1rem' }, h('button', { onclick: () => d.close() }, 'Close'))));
  d.classList.add('wide');
  try {
    const x = await api('GET', `/docker/containers/${c.id}`);
    const kv = (k, v) => h('tr', null, h('td', { class: 'mut' }, k), h('td', null, v));
    body.replaceChildren(h('table', null, h('tbody', null,
      kv('Image', x.image), kv('Command', (x.cmd || []).join(' ') || '-'), kv('Restart policy', x.restartPolicy || 'no'),
      kv('Networks', Object.entries(x.networks).map(([n, ip]) => `${n} (${ip || '-'})`).join(', ') || '-'),
      kv('Mounts', x.mounts.length ? h('div', null, x.mounts.map((m) => h('div', null, `${m.source} -> ${m.destination}${m.rw ? '' : ' (ro)'}`))) : '-'),
      kv('Environment', h('pre', { class: 'logs', style: 'max-height:160px' }, (x.env || []).join('\n') || '-')))));
  } catch (e) { body.replaceChildren(flash('err', e.message)); }
}

function runDialog() {
  const err = h('div');
  const f = {
    image: h('input', { placeholder: 'nginx:alpine', required: true }), name: h('input', { placeholder: 'optional' }),
    ports: h('textarea', { placeholder: '8080:80\n127.0.0.1:9000:9000/udp' }), env: h('textarea', { placeholder: 'KEY=value' }),
    volumes: h('textarea', { placeholder: '/host/path:/container/path\nmyvolume:/data:ro' }),
    restart: h('select', null, ['unless-stopped', 'always', 'on-failure', 'no'].map((r) => h('option', { value: r }, r))),
    network: h('input', { placeholder: 'e.g. proxy (to reach it from Caddy)' }), command: h('input', { placeholder: 'optional, overrides image CMD' }),
  };
  const btn = h('button', { class: 'pri' }, 'Run');
  const d = dialog('Run container', h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; toast(err, 'ok', 'Starting (pulls the image first if missing - can take a while)...');
      try {
        await api('POST', '/docker/containers', { image: f.image.value, name: f.name.value || undefined, ports: f.ports.value, env: f.env.value, volumes: f.volumes.value, restart: f.restart.value, network: f.network.value || undefined, command: f.command.value || undefined });
        d.close(); render();
      } catch (e2) { btn.disabled = false; toast(err, 'err', e2.message); }
    },
  }, err, h('div', { class: 'grid' }, h('div', null, h('label', null, 'Image'), f.image), h('div', null, h('label', null, 'Name'), f.name)),
  h('div', { class: 'grid' }, h('div', null, h('label', null, 'Ports (hostPort:containerPort, one per line)'), f.ports), h('div', null, h('label', null, 'Environment (one per line)'), f.env)),
  h('label', null, 'Volumes (one per line)'), f.volumes,
  h('div', { class: 'grid' }, h('div', null, h('label', null, 'Restart policy'), f.restart), h('div', null, h('label', null, 'Network'), f.network)),
  h('label', null, 'Command'), f.command,
  h('div', { class: 'row', style: 'margin-top:1rem' }, btn, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
}

async function dockerImages(body) {
  const list = await api('GET', '/docker/images');
  const msg = h('div'), img = h('input', { placeholder: 'repo/image:tag', style: 'max-width:280px' });
  const run = async (fn, okText) => { try { const r = await fn(); if (okText) toast(msg, 'ok', okText(r)); await (okText ? dockerImages(body) : render()); } catch (e) { toast(msg, 'err', e.message); } };
  body.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', null, 'Images'), h('div', { class: 'row' }, img,
      h('button', { class: 'pri', onclick: () => { if (!img.value) return; toast(msg, 'ok', 'Pulling...'); run(() => api('POST', '/docker/images/pull', { image: img.value }), () => `Pulled ${img.value}`); } }, 'Pull'),
      h('button', { onclick: () => run(() => api('POST', '/docker/images/prune'), (r) => `Removed ${r.removed} unused images, freed ${bytes(r.reclaimed)}`) }, 'Prune unused'))), msg,
    h('div', { class: 'tw' }, h('table', null, th(['Tags', 'ID', 'Size', 'Created', 'Used', '']),
      h('tbody', null, list.map((i) => h('tr', null, h('td', null, i.tags.join(', ') || '<none>'), h('td', { class: 'mut' }, i.id), h('td', null, bytes(i.size)), h('td', null, ago(i.created)),
        h('td', null, h('span', { class: `badge ${i.inUse ? 'ok' : ''}` }, i.inUse ? 'in use' : 'unused')),
        h('td', null, h('button', { class: 'bad', disabled: i.inUse, onclick: () => confirmDo(`Remove image ${i.tags[0] || i.id}?`, () => run(() => api('DELETE', `/docker/images/${i.id}`))) }, 'Remove')))),
      list.length === 0 && empty(6, 'No images.'))))));
}

async function dockerVolumes(body) {
  const list = await api('GET', '/docker/volumes'), msg = h('div');
  body.replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Volumes'), msg, h('div', { class: 'tw' }, h('table', null, th(['Name', 'Driver', 'Mountpoint', 'Used', '']),
    h('tbody', null, list.map((v) => h('tr', null, h('td', null, v.name), h('td', null, v.driver), h('td', { class: 'mut' }, v.mountpoint),
      h('td', null, h('span', { class: `badge ${v.inUse ? 'ok' : ''}` }, v.inUse ? 'in use' : 'unused')),
      h('td', null, h('button', { class: 'bad', disabled: v.inUse, onclick: () => confirmDo(`Delete volume ${v.name}? Its data is lost.`, async () => { try { await api('DELETE', `/docker/volumes/${v.name}`); render(); } catch (e) { toast(msg, 'err', e.message); } }) }, 'Delete')))),
    list.length === 0 && empty(5, 'No volumes.'))))));
}

async function dockerNetworks(body) {
  const list = await api('GET', '/docker/networks');
  body.replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Networks'), h('div', { class: 'tw' }, h('table', null, th(['Name', 'Driver', 'Scope', 'Subnet', 'Containers', 'Internal']),
    h('tbody', null, list.map((n) => h('tr', null, h('td', null, n.name), h('td', null, n.driver), h('td', null, n.scope), h('td', null, n.subnet || '-'), h('td', null, n.containers), h('td', null, n.internal ? 'yes' : 'no'))))))));
}

// ======================= Files =======================
// A "file system adapter" hides whether we browse a mounted host folder or the inside of a container.
const enc = encodeURIComponent;
const hostFs = (root) => ({
  label: root.name, writable: root.writable,
  list: (p) => api('GET', `/files/list?root=${root.slug}&path=${enc(p)}`),
  dl: (p) => `/api/files/download?root=${root.slug}&path=${enc(p)}`,
  up: (dir, name) => `/api/files/upload?root=${root.slug}&path=${enc(dir)}&name=${enc(name)}`,
  mkdir: (dir, name) => api('POST', '/files/mkdir', { root: root.slug, path: dir, name }),
  rename: (p, newName) => api('POST', '/files/rename', { root: root.slug, path: p, newName }),
  del: (p) => api('DELETE', `/files?root=${root.slug}&path=${enc(p)}`),
});
const containerFs = (c) => {
  const base = `/docker/containers/${c.id}/fs`;
  return {
    label: c.name, writable: true,
    list: (p) => api('GET', `${base}/list?path=${enc(p)}`),
    dl: (p) => `/api${base}/download?path=${enc(p)}`,
    up: (dir, name) => `/api${base}/upload?path=${enc(dir)}&name=${enc(name)}`,
    mkdir: (dir, name) => api('POST', `${base}/mkdir`, { path: dir, name }),
    rename: (p, newName) => api('POST', `${base}/rename`, { path: p, newName }),
    del: (p) => api('DELETE', `${base}?path=${enc(p)}`),
  };
};

async function filesPage(main) {
  const roots = await api('GET', '/files/roots');
  let sel = state.files.root;
  if (!sel || (sel !== '@c' && !roots.some((r) => r.slug === sel))) sel = state.files.root = roots[0]?.slug || '@c';
  const inContainer = sel === '@c';
  const msg = h('div');
  const pick = (root) => { state.files = { root, path: '/', container: state.files.container }; render(); };
  const tabs = h('div', { class: 'row' },
    roots.map((r) => h('button', { class: r.slug === sel ? 'pri' : '', onclick: () => pick(r.slug) }, r.name, r.writable ? '' : ' (ro)')),
    h('button', { class: inContainer ? 'pri' : '', onclick: () => pick('@c') }, 'Docker containers'));
  const head = h('div', { class: 'row sp' }, h('h2', null, 'Files'), tabs);

  let fsx, picker = null;
  if (inContainer) {
    let running = [];
    try { running = (await api('GET', '/docker/containers')).filter((x) => x.state === 'running'); }
    catch (e) { return main.replaceChildren(h('div', { class: 'card' }, head, flash('err', e.message))); }
    if (!running.length) return main.replaceChildren(h('div', { class: 'card' }, head, h('p', { class: 'mut' }, 'No running containers. (Files inside a container are read through the running container.)')));
    if (!running.some((x) => x.id === state.files.container)) state.files.container = running[0].id;
    const c = running.find((x) => x.id === state.files.container);
    fsx = containerFs(c);
    picker = h('select', { onchange: (e) => { state.files.container = e.target.value; state.files.path = '/'; render(); }, style: 'max-width:260px' },
      running.map((x) => h('option', { value: x.id, selected: x.id === c.id }, x.name)));
  } else {
    if (!roots.length) return main.replaceChildren(h('div', { class: 'card' }, head, h('p', null, 'No folders are mounted.'),
      h('p', { class: 'mut' }, 'Set MOUNT_1_PATH (and optionally MOUNT_1_NAME, MOUNT_1_MODE=rw) in .env, then run: docker compose up -d')));
    fsx = hostFs(roots.find((r) => r.slug === sel));
  }

  let data;
  try { data = await fsx.list(state.files.path); state.files.ok = state.files.path; }
  catch (e) {
    toast(msg, 'err', e.message);
    const back = state.files.ok || '/';
    if (state.files.path !== back) { state.files.path = back; try { data = await fsx.list(back); } catch { /* fall through */ } }
    data ||= { path: '/', entries: [] };
  }
  const cur = data.path, join = (n) => (cur === '/' ? '' : cur) + '/' + n;
  const go = (p) => { state.files.path = p; render(); };
  const act = async (fn) => { try { await fn(); render(); } catch (e) { toast(msg, 'err', e.message); } };
  const crumbs = cur.split('/').filter(Boolean);
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true });
  fileIn.addEventListener('change', async () => {
    for (const f of fileIn.files) {
      toast(msg, 'ok', `Uploading ${f.name} (${bytes(f.size)})...`);
      try {
        const r = await fetch(fsx.up(cur, f.name), { method: 'PUT', body: f });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      } catch (e) { toast(msg, 'err', `${f.name}: ${e.message}`); return; }
    }
    render();
  });

  const nameCell = (e) => {
    const badge = e.symlink ? h('span', { class: 'badge' }, e.target ? `link -> ${e.target}` : 'link') : null;
    if (e.type === 'dir' || e.type === 'link') return h('td', null, h('a', { class: 'link', onclick: () => go(join(e.name)) }, (e.type === 'dir' ? '[ ] ' : '') + e.name), badge);
    if (e.type === 'file') return h('td', null, h('a', { class: 'link', href: fsx.dl(join(e.name)) }, e.name), badge);
    return h('td', null, e.name, badge);
  };
  main.replaceChildren(h('div', { class: 'card' }, head,
    h('div', { class: 'row sp', style: 'margin:.6rem 0' },
      h('div', { class: 'row' }, picker, h('span', null, h('a', { class: 'link', onclick: () => go('/') }, picker ? '/' : fsx.label),
        crumbs.map((c, i) => [' / ', h('a', { class: 'link', onclick: () => go('/' + crumbs.slice(0, i + 1).join('/')) }, c)]))),
      fsx.writable ? h('div', { class: 'row' },
        h('button', { onclick: () => promptDialog('New folder', 'Folder name', '', (v) => act(() => fsx.mkdir(cur, v))) }, '+ Folder'),
        h('button', { class: 'pri', onclick: () => fileIn.click() }, 'Upload'), fileIn)
        : h('span', { class: 'badge warn' }, 'read-only')),
    inContainer && h('p', { class: 'mut' }, 'Browsing inside the running container (uses its ls/mkdir/mv/rm). Uploaded files are created as root, mode 0644.'),
    msg,
    h('div', { class: 'tw' }, h('table', null, th(['Name', 'Size', 'Modified', '']),
      h('tbody', null, cur !== '/' && h('tr', null, h('td', { colspan: 4 }, h('a', { class: 'link', onclick: () => go('/' + crumbs.slice(0, -1).join('/')) }, '.. (up)'))),
        data.entries.map((e) => h('tr', null, nameCell(e),
          h('td', null, e.size == null ? '-' : bytes(e.size)), h('td', { class: 'mut' }, e.mtime ? e.mtime.replace('T', ' ').slice(0, 16) : '-'),
          h('td', { class: 'row' },
            (e.type === 'file' || e.type === 'dir' || e.type === 'link') && h('a', { class: 'btn', href: fsx.dl(join(e.name)) }, e.type === 'dir' ? 'Download .tar' : 'Download'),
            fsx.writable && h('button', { onclick: () => promptDialog('Rename', 'New name', e.name, (v) => act(() => fsx.rename(join(e.name), v))) }, 'Rename'),
            fsx.writable && h('button', { class: 'bad', onclick: () => confirmDo(`Delete ${e.name}${e.type === 'dir' ? ' and everything inside it' : ''}?`, () => act(() => fsx.del(join(e.name)))) }, 'Delete')))),
        data.entries.length === 0 && empty(4, 'Empty folder.'))))));
}

function promptDialog(title, label, value, onOk) {
  const input = h('input', { value, required: true });
  const d = dialog(title, h('form', { onsubmit: (e) => { e.preventDefault(); d.close(); onOk(input.value); } },
    h('label', null, label), input, h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'OK'), h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
  input.focus(); input.select();
}

// ---------- API tokens (CI) ----------
async function tokensCard() {
  const { tokens, env_token_enabled: envOn } = await api('GET', '/tokens');
  const msg = h('div');
  const name = h('input', { placeholder: 'e.g. github-actions', required: true });
  const scope = h('select', null, h('option', { value: 'write' }, 'write (create/update hosts + certificates)'), h('option', { value: 'read' }, 'read-only'));
  const days = h('input', { type: 'number', min: 1, max: 3650, placeholder: 'never' });
  return h('div', { class: 'card' }, h('h2', null, 'API tokens (CI / scripts)'),
    h('p', { class: 'mut' }, 'Tokens can only manage proxy hosts and certificates (Lets Encrypt issuance included) - never Docker, files, users or settings. Send as: Authorization: Bearer <token>.'),
    h('p', null, 'CERT_ASK_TOKEN (.env): ', h('span', { class: `badge ${envOn ? 'ok' : ''}` }, envOn ? 'enabled' : 'not set')), msg,
    h('div', { class: 'tw' }, h('table', null, th(['Name', 'Token', 'Scope', 'Expires', 'Last used', '']),
      h('tbody', null, tokens.map((t) => h('tr', null, h('td', null, t.name, h('div', { class: 'mut' }, `by ${t.created_by || '-'}`)), h('td', { class: 'mut' }, `${t.prefix}...`),
        h('td', null, t.scope), h('td', null, t.expires_at ? t.expires_at.slice(0, 10) : 'never'), h('td', { class: 'mut' }, t.last_used_at || '-'),
        h('td', null, h('button', { class: 'bad', onclick: () => confirmDo(`Revoke "${t.name}"? Anything using it stops working.`, async () => { try { await api('DELETE', `/tokens/${t.id}`); render(); } catch (e) { toast(msg, 'err', e.message); } }) }, 'Revoke')))),
      tokens.length === 0 && empty(6, 'No tokens yet.')))),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/tokens', { name: name.value, scope: scope.value, expires_days: days.value ? Number(days.value) : undefined });
        const box = h('input', { readonly: true, value: r.token, style: 'font-family:monospace' });
        const d = dialog('Token created', h('div', null, flash('warn', 'Copy it now - it is shown only once.'), box,
          h('p', { class: 'mut' }, 'Example:'), h('pre', { class: 'logs' }, `curl -X PUT ${location.origin}/api/hosts/by-domain/app.example.com \
  -H "Authorization: Bearer ${r.token}" -H "Content-Type: application/json" \
  -d '{"forward_host":"app","forward_port":8080,"ssl_mode":"letsencrypt","force_ssl":true}'`),
          h('div', { style: 'margin-top:1rem' }, h('button', { class: 'pri', onclick: () => d.close() }, 'Done'))), () => render());
        d.classList.add('wide'); box.focus(); box.select();
      } catch (err) { toast(msg, 'err', err.message); }
    } }, h('div', { class: 'grid' }, h('div', null, h('label', null, 'Name'), name), h('div', null, h('label', null, 'Scope'), scope), h('div', null, h('label', null, 'Expires in (days, optional)'), days)),
    h('div', { style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Create token'))));
}


// ---------- panel domain ----------
async function panelDomainCard() {
  const [p, certs] = await Promise.all([api('GET', '/settings/panel-domain'), api('GET', '/certificates')]);
  const msg = h('div'), status = h('div');
  const f = {
    domain: h('input', { value: p.domain, placeholder: 'panel.example.com', required: true }),
    ssl: h('select', null, [['letsencrypt', "Let's Encrypt (auto, public domain)"], ['internal', 'Internal CA (LAN)'], ['custom', 'Custom certificate'], ['none', 'No SSL (HTTP)']]
      .map(([k, t]) => h('option', { value: k, selected: p.ssl_mode === k }, t))),
    cert: h('select', null, certs.map((c) => h('option', { value: c.id, selected: p.certificate_id === c.id }, `${c.name} (${c.domains.join(', ')})`))),
    force: h('input', { type: 'checkbox', checked: p.domain ? p.force_ssl : true }), hsts: h('input', { type: 'checkbox', checked: p.hsts }),
  };
  const certRow = h('div', null, h('label', null, 'Certificate'), f.cert);
  const sslOpts = h('div', null, h('label', { class: 'ck' }, f.force, 'Force SSL (redirect HTTP to HTTPS)'), h('label', { class: 'ck' }, f.hsts, 'HSTS'));
  const sync = () => { certRow.hidden = f.ssl.value !== 'custom'; sslOpts.hidden = f.ssl.value === 'none'; };
  f.ssl.addEventListener('change', sync); sync();
  const checkSsl = async (wait) => {
    toast(status, 'ok', wait ? 'Waiting for the certificate (up to 2 min)...' : 'Checking...');
    try {
      const r = await api('GET', `/settings/panel-domain/ssl-status${wait ? '?wait=120' : ''}`);
      toast(status, r.ready ? 'ok' : 'warn', r.ssl_mode === 'none' ? 'No SSL configured.' : r.domains.map((d) => d.ok ? `${d.domain}: ${d.issuer}, ${d.daysLeft} days left` : `${d.domain}: no certificate yet (${d.error}) - DNS must point to this server and ports 80/443 be open`).join(' | '));
    } catch (e) { toast(status, 'err', e.message); }
  };
  return h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('PUT', '/settings/panel-domain', { domain: f.domain.value, ssl_mode: f.ssl.value, certificate_id: f.ssl.value === 'custom' ? Number(f.cert.value) : undefined, force_ssl: f.force.checked, hsts: f.hsts.checked });
      toast(msg, r.applied ? 'ok' : 'warn', r.applied ? `Saved. Panel is now also served at ${r.url}` : `Saved, but Caddy was not updated: ${r.warning}`);
    } catch (err) { toast(msg, 'err', err.message); }
  } }, h('h2', null, 'Panel domain'),
  h('p', { class: 'mut' }, p.domain ? `Currently served at ${p.url}.` : 'Serve this panel on a domain or subdomain through Caddy.',
    ' The local address (http://127.0.0.1:8181) always keeps working, so a wrong setting can never lock you out.'), msg,
  h('label', null, 'Domain / subdomain (DNS A/AAAA record must point to this server)'), f.domain, h('label', null, 'SSL'), f.ssl, certRow, sslOpts,
  h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Save'),
    p.domain && h('button', { type: 'button', onclick: () => checkSsl(false) }, 'Check SSL'),
    p.domain && p.ssl_mode === 'letsencrypt' && h('button', { type: 'button', onclick: () => checkSsl(true) }, 'Wait for certificate'),
    p.domain && h('button', { type: 'button', class: 'bad', onclick: () => confirmDo('Remove the panel domain? The panel stays reachable on its local address.', async () => { try { await api('DELETE', '/settings/panel-domain'); render(); } catch (err) { toast(msg, 'err', err.message); } }) }, 'Remove domain')),
  status);
}

render();
