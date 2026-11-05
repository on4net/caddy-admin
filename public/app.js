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
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
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

const state = { notice: null, user: null, page: 'dashboard', dockerTab: 'containers', files: { src: null, path: '/' }, clip: null, timer: null };
const pages = {
  dashboard: ['Dashboard', dashboard], monitor: ['Monitoring', monitorPage],
  docker: ['Docker', dockerPage, true], files: ['Files', filesPage, true],
  hosts: ['Proxy Hosts', hostsPage], certs: ['SSL Certificates', certsPage],
  users: ['Users', usersPage, true], settings: ['Settings', settingsPage],
};

/** Small message in the bottom corner: seen wherever the page is scrolled, never moves the layout. */
function notify(kind, text) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, title: 'Click to dismiss', onclick: () => t.remove() }, text);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 10_000 : 4_500);
}
const flash = (kind, text) => h('div', { class: `msg ${kind}` }, text);
const fmtDate = (s) => (s ? s.slice(0, 10) : '-');
const toast = (box, kind, text) => { box.replaceChildren(flash(kind, text)); };
const applyNote = (r) => (r.applied === false ? `Saved, but Caddy was not updated: ${r.warning}` : null);

async function render() {
  clearInterval(state.timer);
  state.soft = null;
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
      h('span', { class: 'mut who' }, state.user.email),
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
    domain: h('input', { placeholder: 'panel.example.com  (just the name, no https://)' }),
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
            ? { kind: 'ok', text: `Panel domain set: ${f.ssl.value === 'none' ? 'http' : 'https'}://${f.domain.value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')} - make sure its DNS points to this server (ports 80/443). Check status in Settings.` }
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

// ---------- add a custom SSL certificate in a modal (used from the host dialog and the panel-domain card) ----------
function certUploadDialog(onDone) {
  const err = h('div');
  const name = h('input', { required: true, placeholder: 'e.g. wildcard-example-com' });
  const cert = h('textarea', { required: true, placeholder: '-----BEGIN CERTIFICATE-----   (certificate, plus intermediates if you have them)' });
  const key = h('textarea', { required: true, placeholder: '-----BEGIN PRIVATE KEY-----   (unencrypted)' });
  const fromFile = (ta, label) => h('label', { class: 'mut', style: 'display:block;margin:.3rem 0 0' }, `or load ${label} from a file: `,
    h('input', { type: 'file', accept: '.pem,.crt,.cer,.key,.txt', style: 'width:auto;display:inline-block;padding:.2rem', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      ta.value = await f.text();
      if (!name.value) name.value = f.name.replace(/\.[^.]+$/, '');
    } }));
  const btn = h('button', { class: 'pri' }, 'Add certificate');
  const d = dialog('Add SSL certificate', h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      try { const c = await api('POST', '/certificates', { name: name.value, certificate: cert.value, private_key: key.value }); d.close(); onDone(c); }
      catch (e2) { btn.disabled = false; toast(err, 'err', e2.message); }
    },
  }, err, h('p', { class: 'mut' }, 'Paste the PEM text or load the files. The private key must match the certificate and must not be password-protected. The certificate has to cover the host\'s domain (wildcards like *.example.com are fine).'),
  h('label', null, 'Name'), name,
  h('label', null, 'Certificate (PEM)'), cert, fromFile(cert, 'the certificate'),
  h('label', null, 'Private key (PEM)'), key, fromFile(key, 'the key'),
  h('div', { class: 'row', style: 'margin-top:1rem' }, btn, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
  d.classList.add('wide');
  name.focus();
}

/** A <select> of certificates + an "Add certificate" button that opens the modal and selects the new one. */
function certPicker(certs, selectedId) {
  const sel = h('select');
  const fill = (id) => {
    sel.replaceChildren(...certs.map((c) => h('option', { value: c.id, selected: c.id === id }, `${c.name} (${c.domains.join(', ')})`)));
    if (!certs.length) sel.append(h('option', { value: '' }, '- no certificates yet -'));
  };
  const add = () => certUploadDialog((c) => { certs.push(c); fill(c.id); });
  fill(selectedId);
  const box = h('div', null, h('label', null, 'Certificate'), h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:200px' }, sel), h('button', { type: 'button', onclick: add }, '+ Add certificate')));
  return { sel, box, add, count: () => certs.length };
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
    force: h('input', { type: 'checkbox', checked: !!v.force_ssl }), hsts: h('input', { type: 'checkbox', checked: !!v.hsts }),
    skip: h('input', { type: 'checkbox', checked: !!v.skip_upstream_verify }),
  };
  const picker = certPicker(certs, v.certificate_id); f.cert = picker.sel;
  const sslOnly = h('div'); const certRow = h('div');
  const sync = () => {
    sslOnly.hidden = f.ssl.value === 'none'; certRow.hidden = f.ssl.value !== 'custom';
  };
  f.ssl.addEventListener('change', () => { sync(); if (f.ssl.value === 'custom' && !picker.count()) picker.add(); }); // nothing to pick yet: open the upload modal right away
  sslOnly.append(h('label', { class: 'ck' }, f.force, 'Force SSL (redirect HTTP to HTTPS)'), h('label', { class: 'ck' }, f.hsts, 'HSTS'));
  certRow.append(picker.box);
  const d = dialog(x ? 'Edit host' : 'Add host', h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const body = {
        domains: f.domains.value, forward_scheme: f.scheme.value, forward_host: f.host.value, forward_port: Number(f.port.value),
        ssl_mode: f.ssl.value, certificate_id: f.ssl.value === 'custom' ? Number(f.cert.value) : null,
        force_ssl: f.force.checked, hsts: f.hsts.checked, skip_upstream_verify: f.skip.checked, enabled: v.enabled === 1,
      };
      try { const r = await api(x ? 'PUT' : 'POST', x ? `/hosts/${x.id}` : '/hosts', body); d.close(); await act(async () => r); } // stay open on errors, so nothing typed is lost
      catch (e2) { toast(err, 'err', e2.message); }
    },
  }, err, h('label', null, 'Domain names (comma separated)'), f.domains,
  h('div', { class: 'grid' }, h('div', null, h('label', null, 'Scheme'), f.scheme), h('div', null, h('label', null, 'Forward host'), f.host), h('div', null, h('label', null, 'Port'), f.port)),
  h('p', { class: 'mut', style: 'margin:.3rem 0' }, 'WebSockets (ws:// and wss://), Server-Sent Events and gRPC pass through automatically - there is nothing to enable.'),
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
  const tabs = ['containers', 'images', 'volumes', 'networks', 'registries'];
  let info;
  try { info = await api('GET', '/docker/info'); }
  catch (e) { return main.replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Docker'), flash('err', e.message))); }
  const body = h('div');
  const head = h('div', { class: 'card row sp' },
    h('div', null, `Docker ${info.version}`, h('span', { class: 'mut' }, ` - ${info.os} - ${info.running} running / ${info.containers} containers - ${info.images} images`)),
    h('div', { class: 'row' }, tabs.map((t) => h('button', { class: state.dockerTab === t ? 'pri' : '', onclick: () => { state.dockerTab = t; render(); } }, t[0].toUpperCase() + t.slice(1)))));
  main.replaceChildren(head, body);
  await { containers: dockerContainers, images: dockerImages, volumes: dockerVolumes, networks: dockerNetworks, registries: dockerRegistries }[state.dockerTab](body);
}

const stateBadge = (st) => h('span', { class: `badge ${st === 'running' ? 'ok' : st === 'exited' || st === 'dead' ? 'bad' : 'warn'}` }, st);

// ======================= Docker containers: search, filter, sort, and refresh without losing your place =======================
const STATE_RANK = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };
const dockerStats = { at: 0, byId: {} }; // CPU/memory cache, so redrawing the list never waits for the (slow) stats call
const DOCKER_UI_DEFAULTS = { q: '', status: 'all', stack: '', net: '', sort: 'name', dir: 1, auto: false };
const loadDockerUI = () => { try { return { ...DOCKER_UI_DEFAULTS, ...JSON.parse(localStorage.getItem('caddyadmin.docker') || '{}') }; } catch { return { ...DOCKER_UI_DEFAULTS }; } };
const saveDockerUI = (ui) => { try { localStorage.setItem('caddyadmin.docker', JSON.stringify(ui)); } catch { /* private mode: keep it in memory only */ } };
/** Refresh whatever list is on screen in place (falls back to a full render when there is none). */
const soft = () => (state.soft ? state.soft() : render());

async function dockerContainers(body) {
  const ui = (state.dockerUI ||= loadDockerUI());
  let list = await api('GET', '/docker/containers');
  const busy = new Set(), cells = {};
  let flashId = null;
  const say = notify;

  // ---- toolbar (built once: typing keeps focus while the rows below are redrawn)
  const q = h('input', { type: 'search', placeholder: 'Search name, image, stack, port, network, IP...', value: ui.q, style: 'flex:2;min-width:220px' });
  const selState = h('select', null, [['all', 'All states'], ['running', 'Running'], ['stopped', 'Stopped / exited'], ['other', 'Other']].map(([v, t]) => h('option', { value: v, selected: ui.status === v }, t)));
  const selStack = h('select'), selNet = h('select');
  const selSort = h('select', null, [['name', 'Sort: name'], ['state', 'Sort: state'], ['image', 'Sort: image'], ['stack', 'Sort: stack'], ['cpu', 'Sort: CPU'], ['mem', 'Sort: memory']].map(([v, t]) => h('option', { value: v, selected: ui.sort === v }, t)));
  const dirBtn = h('button', { title: 'Reverse the order' });
  const auto = h('input', { type: 'checkbox', checked: ui.auto });
  const count = h('span', { class: 'mut' });
  const tbody = h('tbody');
  const SORT_COLS = [['Name', 'name'], ['Image', 'image'], ['State', 'state'], ['CPU / Mem', 'cpu']];
  const sortTh = ([label, key]) => h('th', { class: 'sort', onclick: () => { ui.dir = ui.sort === key ? -ui.dir : 1; ui.sort = key; selSort.value = key; change(); } }, label);
  const thead = h('thead', null, h('tr', null, ...SORT_COLS.map(sortTh), h('th', null, 'Ports'), h('th', null, 'Networks')));
  const syncHead = () => [...thead.querySelectorAll('th.sort')].forEach((th, i) => { th.textContent = SORT_COLS[i][0] + (ui.sort === SORT_COLS[i][1] ? (ui.dir > 0 ? ' ▲' : ' ▼') : ''); }); // arrow follows the dropdown too

  const options = (el, first, values, current) => {
    el.replaceChildren(...first.map(([v, t]) => h('option', { value: v }, t)), ...values.map((v) => h('option', { value: v }, v)));
    el.value = [...el.options].some((o) => o.value === current) ? current : '';
  };
  const fillOptions = () => {
    const stacks = [...new Set(list.map((c) => c.project).filter(Boolean))].sort(), nets = [...new Set(list.flatMap((c) => c.networks))].sort();
    options(selStack, [['', 'All stacks'], ['__none', '(no stack)']], stacks, ui.stack); ui.stack = selStack.value;
    options(selNet, [['', 'All networks']], nets, ui.net); ui.net = selNet.value;
  };

  const hay = (c) => (c._hay ||= [c.name, c.image, c.id, c.project, c.state, c.status, c.ports, ...(c.networkInfo || []).flatMap((n) => [n.name, n.ip])].join(' ').toLowerCase());
  const visible = () => {
    const tokens = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = list.filter((c) => {
      if (ui.status === 'running' && c.state !== 'running') return false;
      if (ui.status === 'stopped' && !['exited', 'dead', 'created'].includes(c.state)) return false;
      if (ui.status === 'other' && ['running', 'exited', 'dead', 'created'].includes(c.state)) return false;
      if (ui.stack === '__none' ? c.project : ui.stack && c.project !== ui.stack) return false;
      if (ui.net && !c.networks.includes(ui.net)) return false;
      const h2 = hay(c); return tokens.every((t) => h2.includes(t)); // every word must match somewhere
    });
    const val = { name: (c) => c.name.toLowerCase(), image: (c) => c.image.toLowerCase(), stack: (c) => c.project.toLowerCase() || '￿',
      state: (c) => STATE_RANK[c.state] ?? 9, cpu: (c) => dockerStats.byId[c.id]?.cpu ?? -1, mem: (c) => dockerStats.byId[c.id]?.memUsed ?? -1 }[ui.sort];
    return rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * ui.dir; });
  };

  const paintStats = () => {
    for (const [id, td] of Object.entries(cells)) {
      const s = dockerStats.byId[id];
      if (s) td.replaceChildren(`${s.cpu}% / ${bytes(s.memUsed)}${s.memLimit ? ` of ${bytes(s.memLimit)}` : ''}`);
    }
  };
  const refreshStats = async (force) => {
    if (!force && Date.now() - dockerStats.at < 20_000) return; // slow call: at most every 20 s
    dockerStats.at = Date.now();
    try { dockerStats.byId = await api('GET', '/docker/containers/stats'); paintStats(); if (['cpu', 'mem'].includes(ui.sort)) drawRows(); } catch { /* optional */ }
  };

  // ---- one action on one container: only that row shows progress, then only the list is re-read
  const act = async (c, verb, fn) => {
    busy.add(c.id); drawRows();
    try { await fn(); say('ok', `${verb}: ${c.name}`); flashId = c.id; }
    catch (e) { say('err', `${c.name}: ${e.message}`); }
    busy.delete(c.id); await reload();
  };
  const post = (c, a) => api('POST', `/docker/containers/${c.id}/${a}`);

  const rowsFor = (c) => {
    const live = h('td', { class: 'mut' }, c.state === 'running' ? '...' : '-'); cells[c.id] = live;
    const off = busy.has(c.id), cls = `${flashId === c.id ? 'flash' : ''} ${off ? 'busy' : ''}`;
    const btn = (label, fn, extra = {}) => h('button', { disabled: off, onclick: fn, ...extra }, label);
    return [
      h('tr', { class: `info ${cls}` },
        h('td', null, h('b', null, c.name), c.self && h('span', { class: 'badge' }, 'this panel'), h('div', { class: 'mut' }, c.project ? `stack: ${c.project}` : c.id)),
        h('td', null, c.image), h('td', null, stateBadge(c.state), h('div', { class: 'mut' }, off ? 'working...' : c.status)), live, h('td', null, c.ports || '-'),
        h('td', null, c.networkInfo?.length ? c.networkInfo.map((n) => h('div', null, h('span', { class: 'badge' }, n.name), n.ip && h('span', { class: 'mut' }, ' ' + n.ip))) : '-')),
      // actions get their own full-width row, so they never get squeezed or pushed off-screen
      h('tr', { class: `actions ${cls}` }, h('td', { colspan: 6 }, h('div', { class: 'row wrap' },
        c.state !== 'running' && btn('Start', () => act(c, 'Started', () => post(c, 'start'))),
        c.state === 'running' && !c.self && btn('Stop', () => act(c, 'Stopped', () => post(c, 'stop'))),
        c.state === 'running' && !c.self && btn('Restart', () => act(c, 'Restarted', () => post(c, 'restart'))),
        btn('Logs', () => logsDialog(c)),
        c.state === 'running' && btn('Terminal', () => terminalDialog(c)),
        c.state === 'running' && btn('Files', () => { state.files = { src: 'container:' + c.id, path: '/', lastContainer: 'container:' + c.id }; state.page = 'files'; render(); }),
        btn('Networks', () => networksDialog(c)), btn('Pull / Update', () => updateDialog(c)), btn('Details', () => detailsDialog(c)),
        !c.self && btn('Remove', () => confirmDo(`Remove container ${c.name}? (forces stop if running)`, () => act(c, 'Removed', () => api('DELETE', `/docker/containers/${c.id}?force=1`))), { class: 'bad' })))),
    ];
  };

  const drawRows = () => {
    for (const k of Object.keys(cells)) delete cells[k];
    const rows = visible();
    tbody.replaceChildren(...[...rows.flatMap(rowsFor), rows.length === 0 && empty(6, list.length ? 'No container matches the search / filters.' : 'No containers.')].filter(Boolean));
    const running = list.filter((c) => c.state === 'running').length;
    count.textContent = `Showing ${rows.length} of ${list.length} - ${running} running`;
    dirBtn.textContent = ui.dir > 0 ? 'A-Z ▲' : 'Z-A ▼';
    paintStats();
    syncHead();
    if (flashId) setTimeout(() => { flashId = null; tbody.querySelectorAll('.flash').forEach((r) => r.classList.remove('flash')); }, 2000);
  };
  const reload = async () => {
    try { list = await api('GET', '/docker/containers'); } catch (e) { say('err', e.message); }
    fillOptions(); drawRows(); refreshStats(false);
  };
  state.soft = reload; // dialogs call soft() instead of re-rendering the whole page

  // ---- wiring
  let qTimer = null;
  const change = () => { saveDockerUI(ui); drawRows(); };
  q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.q = q.value; change(); }, 120); });
  selState.addEventListener('change', () => { ui.status = selState.value; change(); });
  selStack.addEventListener('change', () => { ui.stack = selStack.value; change(); });
  selNet.addEventListener('change', () => { ui.net = selNet.value; change(); });
  selSort.addEventListener('change', () => { ui.sort = selSort.value; change(); if (['cpu', 'mem'].includes(ui.sort)) refreshStats(true); });
  dirBtn.addEventListener('click', () => { ui.dir = -ui.dir; change(); });
  const applyAuto = () => { clearInterval(state.timer); state.timer = ui.auto ? setInterval(() => reload(), 10_000) : null; };
  auto.addEventListener('change', () => { ui.auto = auto.checked; saveDockerUI(ui); applyAuto(); });
  fillOptions();
  body.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', null, 'Containers'), h('button', { class: 'pri', onclick: () => runDialog() }, '+ Run container')),
    h('div', { class: 'toolbar' }, q, selState, selStack, selNet, selSort, dirBtn, h('button', { onclick: () => reload() }, 'Refresh'), h('label', { class: 'ck', style: 'margin:0' }, auto, 'auto-refresh (10 s)')),
    h('div', { class: 'row sp' }, count),
    h('div', { class: 'tw' }, h('table', null, thead, tbody))));
  drawRows(); applyAuto(); refreshStats(true);
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
        d.close(); soft();
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

// ---------- networks of one container ----------
async function networksDialog(c) {
  const body = h('div', { class: 'mut' }, 'Loading...');
  const d = dialog(`Networks - ${c.name}`, h('div', null, body, h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { onclick: () => d.close() }, 'Close'))), () => soft());
  d.classList.add('wide');
  const draw = async () => {
    try {
      const [cur, all] = await Promise.all([api('GET', `/docker/containers/${c.id}/networks`), api('GET', '/docker/networks')]);
      const attached = new Set(cur.networks.map((n) => n.name));
      const free = all.filter((n) => !attached.has(n.name) && !['host', 'none'].includes(n.name));
      const msg = h('div');
      const net = h('select', null, free.map((n) => h('option', { value: n.name }, n.name + (n.subnets[0] ? ` (${n.subnets[0].subnet})` : ''))));
      const aliases = h('input', { placeholder: 'comma separated, optional' }), ip = h('input', { placeholder: 'optional, e.g. 172.20.0.50' });
      const detach = (n) => confirmDo(`Disconnect ${c.name} from "${n.name}"? Anything that reaches it through that network (including Caddy) loses access.`,
        async () => { try { await api('POST', `/docker/containers/${c.id}/networks/disconnect`, { network: n.name }); await draw(); } catch (e) { toast(msg, 'err', e.message); } });
      body.replaceChildren(
        cur.mode && h('p', { class: 'mut' }, `Network mode: ${cur.mode}`),
        h('div', { class: 'tw' }, h('table', null, th(['Network', 'IP', 'Gateway', 'MAC', 'Aliases', '']),
          h('tbody', null, cur.networks.map((n) => h('tr', null,
            h('td', null, h('b', null, n.name), n.static && h('span', { class: 'badge' }, 'static ip')), h('td', null, n.ip || '-'), h('td', null, n.gateway || '-'),
            h('td', { class: 'mut' }, n.mac || '-'), h('td', null, n.aliases.join(', ') || '-'),
            h('td', null, !c.self && h('button', { class: 'bad', onclick: () => detach(n) }, 'Disconnect')))),
          cur.networks.length === 0 && empty(6, 'Not connected to any network.')))),
        msg,
        h('h2', { style: 'margin-top:1.2rem' }, 'Connect to another network'),
        free.length
          ? h('div', null, h('div', { class: 'grid' }, h('div', null, h('label', null, 'Network'), net), h('div', null, h('label', null, 'Aliases'), aliases), h('div', null, h('label', null, 'Static IPv4'), ip)),
            h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'pri', onclick: async () => {
              try { await api('POST', `/docker/containers/${c.id}/networks/connect`, { network: net.value, aliases: aliases.value, ipv4: ip.value || undefined }); await draw(); }
              catch (e) { toast(msg, 'err', e.message); }
            } }, 'Connect')))
          : h('p', { class: 'mut' }, 'Already connected to every available network.'));
    } catch (e) { body.replaceChildren(flash('err', e.message)); }
  };
  draw();
}

// ---------- pull / update ----------
function updateDialog(c) {
  const out = h('div');
  const pull = h('button', null, 'Pull latest image'), upd = h('button', { class: 'pri' }, 'Pull & update container'), rec = h('button', { class: 'bad' }, 'Recreate now (same image)');
  const all = [pull, upd, rec];
  const go = (label, fn) => async () => {
    all.forEach((b) => { b.disabled = true; }); toast(out, 'ok', label);
    try { await fn(); } catch (e) { toast(out, 'err', e.message); }
    all.forEach((b) => { b.disabled = false; });
  };
  pull.onclick = go('Pulling image...', async () => {
    const r = await api('POST', `/docker/containers/${c.id}/pull`);
    toast(out, r.changed ? 'warn' : 'ok', r.changed
      ? `A newer image of ${r.image} was downloaded (${r.imageId}). The container still runs the old one - press "Pull & update container".`
      : `${r.image} is already the latest.`);
  });
  upd.onclick = go('Pulling and recreating (can take a while)...', async () => {
    const r = await api('POST', `/docker/containers/${c.id}/update`, { pull: true });
    toast(out, r.recreated ? 'ok' : 'warn', r.recreated ? `Updated: the new container (${r.id}) is running.` : r.reason);
  });
  rec.onclick = go('Recreating...', async () => {
    const r = await api('POST', `/docker/containers/${c.id}/update`, { pull: false, force: true });
    toast(out, 'ok', `Recreated: the new container (${r.id}) is running.`);
  });
  const d = dialog(`Update - ${c.name}`, h('div', null,
    h('p', null, 'Image: ', h('b', null, c.image)),
    h('p', { class: 'mut' }, 'Pull downloads the newest image for this tag (saved registry credentials are used automatically: Docker -> Registries). Update then replaces the container with a new one that keeps its ports, environment, volumes, networks and restart policy. If the new container fails to start, the old one is restored. Data in volumes is kept; changes made inside the container\'s own filesystem are lost.'),
    c.self && flash('warn', 'This is the panel itself: pull the image here, then run "docker compose up -d" on the server to switch to it.'),
    out, h('div', { class: 'row', style: 'margin-top:1rem' }, pull, !c.self && upd, !c.self && rec, h('button', { onclick: () => d.close() }, 'Close'))), () => soft());
  d.classList.add('wide');
}

// ---------- networks tab ----------
async function dockerNetworks(body) {
  const list = await api('GET', '/docker/networks'), msg = h('div');
  const act = async (fn) => { try { await fn(); await render(); } catch (e) { toast(msg, 'err', e.message); } };
  body.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('h2', null, 'Networks'), h('button', { class: 'pri', onclick: () => createNetDialog() }, '+ Create network')), msg,
    h('div', { class: 'tw' }, h('table', null, th(['Name', 'Driver / scope', 'Subnet / gateway', 'Containers', 'Flags', '']),
      h('tbody', null, list.map((n) => h('tr', null,
        h('td', null, h('b', null, n.name), n.project && h('div', { class: 'mut' }, `stack: ${n.project}`)), h('td', null, `${n.driver} / ${n.scope}`),
        h('td', null, n.subnets.length ? n.subnets.map((s) => h('div', null, `${s.subnet}${s.gateway ? ` via ${s.gateway}` : ''}`)) : '-'),
        h('td', null, n.containers.length, h('button', { style: 'margin-left:.5rem', onclick: () => membersDialog(n) }, 'Manage')),
        h('td', null, n.internal && h('span', { class: 'badge warn' }, 'internal'), n.builtin && h('span', { class: 'badge' }, 'built-in')),
        h('td', null, !n.builtin && h('button', { class: 'bad', disabled: n.containers.length > 0, title: n.containers.length ? 'Disconnect its containers first' : '',
          onclick: () => confirmDo(`Remove network ${n.name}?`, () => act(() => api('DELETE', `/docker/networks/${n.id}`))) }, 'Remove')))),
      list.length === 0 && empty(6, 'No networks.'))))));
}

function membersDialog(n0) {
  const body = h('div', { class: 'mut' }, 'Loading...');
  const d = dialog(`Containers on ${n0.name}`, h('div', null, body, h('div', { style: 'margin-top:1rem' }, h('button', { onclick: () => d.close() }, 'Close'))), () => render());
  d.classList.add('wide');
  const draw = async () => {
    try {
      const [n, all] = await Promise.all([api('GET', `/docker/networks/${n0.id}`), api('GET', '/docker/containers')]);
      const msg = h('div');
      const members = new Set(n.containers.map((m) => m.name));
      const free = all.filter((c) => !members.has(c.name));
      const pick = h('select', null, free.map((c) => h('option', { value: c.id }, `${c.name}${c.state === 'running' ? '' : ' (stopped)'}`)));
      const aliases = h('input', { placeholder: 'comma separated, optional' }), ip = h('input', { placeholder: 'optional, e.g. 172.20.0.50' });
      const detach = (m) => confirmDo(`Disconnect ${m.name} from "${n.name}"?`, async () => {
        try { await api('POST', `/docker/containers/${m.id}/networks/disconnect`, { network: n.name }); await draw(); } catch (e) { toast(msg, 'err', e.message); }
      });
      const connect = async () => {
        try { await api('POST', `/docker/containers/${pick.value}/networks/connect`, { network: n.name, aliases: aliases.value, ipv4: ip.value || undefined }); await draw(); }
        catch (e) { toast(msg, 'err', e.message); }
      };
      body.replaceChildren(
        h('div', { class: 'tw' }, h('table', null, th(['Container', 'IPv4', 'MAC', '']),
          h('tbody', null, n.containers.map((m) => h('tr', null, h('td', null, h('b', null, m.name)), h('td', null, m.ipv4 || '-'), h('td', { class: 'mut' }, m.mac || '-'),
            h('td', null, h('button', { class: 'bad', onclick: () => detach(m) }, 'Disconnect')))),
          n.containers.length === 0 && empty(4, 'No containers on this network yet.')))),
        msg,
        h('h2', { style: 'margin-top:1.2rem' }, 'Add a container to this network'),
        ['host', 'none'].includes(n.name) ? h('p', { class: 'mut' }, `Containers cannot be added to the "${n.name}" network this way.`)
          : free.length
            ? h('div', null, h('div', { class: 'grid' }, h('div', null, h('label', null, 'Container'), pick), h('div', null, h('label', null, 'Aliases'), aliases), h('div', null, h('label', null, 'Static IPv4'), ip)),
              h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'pri', onclick: connect }, 'Add to network')))
            : h('p', { class: 'mut' }, 'Every container is already on this network.'));
    } catch (e) { body.replaceChildren(flash('err', e.message)); }
  };
  draw();
}

function createNetDialog() {
  const err = h('div');
  const f = { name: h('input', { required: true, placeholder: 'e.g. apps' }), subnet: h('input', { placeholder: 'optional, e.g. 172.31.0.0/24' }), gateway: h('input', { placeholder: 'optional, e.g. 172.31.0.1' }), internal: h('input', { type: 'checkbox' }) };
  const d = dialog('Create network', h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('POST', '/docker/networks', { name: f.name.value, subnet: f.subnet.value || undefined, gateway: f.gateway.value || undefined, internal: f.internal.checked }); d.close(); render(); }
    catch (e2) { toast(err, 'err', e2.message); }
  } }, err, h('label', null, 'Name'), f.name, h('div', { class: 'grid' }, h('div', null, h('label', null, 'Subnet'), f.subnet), h('div', null, h('label', null, 'Gateway'), f.gateway)),
  h('label', { class: 'ck' }, f.internal, 'Internal (containers on it have no outside access)'),
  h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Create'), h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'))));
}

// ---------- registry credentials ----------
async function dockerRegistries(body) {
  const list = await api('GET', '/docker/registries'), msg = h('div');
  const f = {
    server: h('input', { required: true, placeholder: 'docker.can4net.com or host:port' }), user: h('input', { required: true, autocomplete: 'off' }),
    pw: h('input', { type: 'password', required: true, autocomplete: 'new-password' }), skip: h('input', { type: 'checkbox' }),
  };
  body.replaceChildren(
    h('div', { class: 'card' }, h('h2', null, 'Registry logins'),
      h('p', { class: 'mut' }, 'Used automatically whenever an image from that registry is pulled (Images tab, Run container, container Update). Passwords are encrypted in the database; the panel only sends them to the matching registry host.'), msg,
      h('div', { class: 'tw' }, h('table', null, th(['Registry', 'User', 'Added', '']), h('tbody', null, list.map((r) => h('tr', null, h('td', null, h('b', null, r.server)), h('td', null, r.username), h('td', { class: 'mut' }, r.created_at),
        h('td', null, h('button', { class: 'bad', onclick: () => confirmDo(`Forget the login for ${r.server}?`, async () => { try { await api('DELETE', `/docker/registries/${r.id}`); render(); } catch (e) { toast(msg, 'err', e.message); } }) }, 'Remove')))),
      list.length === 0 && empty(4, 'No registry logins yet (public images need none).'))))),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/docker/registries', { server: f.server.value, username: f.user.value, password: f.pw.value, skipVerify: f.skip.checked }); render(); }
      catch (err) { toast(msg, 'err', err.message); }
    } }, h('h2', null, 'Add / replace a login'),
    h('div', { class: 'grid' }, h('div', null, h('label', null, 'Registry'), f.server), h('div', null, h('label', null, 'Username'), f.user), h('div', null, h('label', null, 'Password / token'), f.pw)),
    h('label', { class: 'ck' }, f.skip, 'Save without testing the login'),
    h('div', { style: 'margin-top:1rem' }, h('button', { class: 'pri' }, 'Save'))));
}

// ======================= Files =======================
// ======================= File manager (host folders + inside containers, one UI) =======================
const fq = (o) => new URLSearchParams(o).toString();
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => { if (!ms) return '-'; const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const isZip = (n) => /\.zip$/i.test(n);
const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;

function xhrPut(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let m = `HTTP ${x.status}`; try { m = JSON.parse(x.responseText).error || m; } catch { /* keep */ }
      reject(new Error(m));
    };
    x.onerror = () => reject(new Error('Network error'));
    x.send(file);
  });
}

/** Files dropped on the page: walks dropped folders (webkitGetAsEntry) -> {files:[{file,rel}], dirs:[rel]} */
async function collectDropped(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean); // must be read synchronously
  const out = { files: [], dirs: [] };
  const walk = async (entry, relDir) => {
    if (entry.isFile) { out.files.push({ file: await new Promise((res, rej) => entry.file(res, rej)), rel: relDir }); return; }
    const mine = relDir ? `${relDir}/${entry.name}` : entry.name;
    out.dirs.push(mine);
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, mine);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

async function filesPage(main) {
  const S = await api('GET', '/fm/sources');
  const f = state.files;
  f.sel ||= new Set(); f.sort ||= { key: 'name', dir: 1 };
  const hosts = S.hosts, ctrs = S.containers;
  const inCt = f.src?.startsWith('container:');
  if (!f.src || (!inCt && !hosts.some((h) => h.id === f.src)) || (inCt && !ctrs.some((c) => c.id === f.src))) {
    f.src = hosts[0]?.id || ctrs[0]?.id || null; f.path = '/'; f.ok = null;
  }
  const containerMode = f.src?.startsWith('container:');
  const pickSrc = (src) => { state.files = { ...f, src, path: '/', ok: null, sel: new Set() }; render(); };
  const msg = h('div');
  const tabs = h('div', { class: 'row' },
    hosts.map((x) => h('button', { class: x.id === f.src ? 'pri' : '', onclick: () => pickSrc(x.id) }, x.name, x.writable ? '' : ' (ro)')),
    h('button', { class: containerMode ? 'pri' : '', onclick: () => ctrs.length ? pickSrc(f.lastContainer && ctrs.some((c) => c.id === f.lastContainer) ? f.lastContainer : ctrs[0].id) : toast(msg, 'warn', S.dockerError || 'No running containers') }, 'Docker containers'));
  const head = h('div', { class: 'row sp' }, h('h2', null, 'Files'), tabs);
  if (!f.src) {
    return main.replaceChildren(h('div', { class: 'card' }, head, h('p', null, 'No folders are mounted and no containers are running.'),
      h('p', { class: 'mut' }, 'Set MOUNT_1_PATH (and optionally MOUNT_1_NAME, MOUNT_1_MODE=rw) in .env, then run: docker compose up -d'), msg));
  }
  if (containerMode) f.lastContainer = f.src;
  const src = f.src;

  let data;
  try { data = await api('GET', `/fm/list?${fq({ src, path: f.path })}`); f.ok = f.path; }
  catch (e) {
    toast(msg, 'err', e.message);
    if (f.ok && f.ok !== f.path) { f.path = f.ok; try { data = await api('GET', `/fm/list?${fq({ src, path: f.path })}`); } catch { /* below */ } }
    data ||= { path: '/', entries: [], source: { id: src, label: src, writable: false } };
  }
  const cur = data.path, writable = data.source.writable;
  const go = (p) => { f.path = p; f.sel = new Set(); render(); };
  const act = async (fn, okText) => { try { const r = await fn(); if (okText) state.notice = { kind: 'ok', text: okText(r) }; render(); } catch (e) { toast(msg, 'err', e.message); } };
  const crumbs = cur.split('/').filter(Boolean);
  const sel = () => data.entries.filter((e) => f.sel.has(e.name));
  const selPaths = () => sel().map((e) => joinPath(cur, e.name));
  const enc = encodeURIComponent;
  const dlUrl = (name, inline) => `/api/fm/download?${fq({ src, path: joinPath(cur, name), ...(inline ? { inline: 1 } : {}) })}`;

  // ---- sorting
  const key = f.sort.key;
  const entries = [...data.entries].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    const va = key === 'name' ? a.name.toLowerCase() : (a[key] ?? -1), vb = key === 'name' ? b.name.toLowerCase() : (b[key] ?? -1);
    return (va < vb ? -1 : va > vb ? 1 : 0) * f.sort.dir;
  });
  const sortTh = (label, k) => h('th', { style: 'cursor:pointer', onclick: () => { f.sort = { key: k, dir: f.sort.key === k ? -f.sort.dir : 1 }; render(); } }, label, f.sort.key === k ? (f.sort.dir > 0 ? ' ▲' : ' ▼') : '');

  // ---- upload (files and whole folders, with progress)
  const progress = h('div');
  const overwrite = h('input', { type: 'checkbox', checked: !!f.overwrite, onchange: (e) => { f.overwrite = e.target.checked; } });
  async function upload({ files, dirs = [] }) {
    const need = new Set(dirs);
    for (const it of files) { const parts = it.rel.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) need.add(parts.slice(0, i).join('/')); }
    for (const d of [...need].sort((a, b) => a.split('/').length - b.split('/').length)) { // parents first
      const parts = d.split('/');
      await api('POST', '/fm/mkdir', { src, path: joinPath(cur, parts.slice(0, -1).join('/')).replace(/\/$/, '') || '/', name: parts.at(-1), existOk: true });
    }
    const errors = []; let n = 0;
    for (const it of files) {
      n++;
      const dir = it.rel ? joinPath(cur, it.rel) : cur;
      try {
        await xhrPut(`/api/fm/upload?${fq({ src, path: dir, name: it.file.name, ...(f.overwrite ? { overwrite: 1 } : {}) })}`, it.file,
          (p) => progress.replaceChildren(h('div', { class: 'msg ok' }, `Uploading ${n}/${files.length}: ${it.file.name} - ${p}%`, h('div', { class: 'bar' }, h('i', { style: `width:${p}%` })))));
      } catch (e) { errors.push(`${it.file.name}: ${e.message}`); }
    }
    state.notice = errors.length ? { kind: 'warn', text: `Uploaded ${files.length - errors.length}/${files.length}. ${errors.slice(0, 3).join(' | ')}${errors.length > 3 ? ' ...' : ''}` } : { kind: 'ok', text: `Uploaded ${files.length} file(s).` };
    render();
  }
  const run = (p) => p.catch((e) => toast(msg, 'err', e.message));
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => run(upload({ files: [...e.target.files].map((file) => ({ file, rel: '' })) })) });
  const dirIn = h('input', { type: 'file', hidden: true, webkitdirectory: true, onchange: (e) => run(upload({ files: [...e.target.files].map((file) => ({ file, rel: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/') })) })) });

  // ---- clipboard (copy / cut -> paste in any folder or source)
  const clip = state.clip;
  const setClip = (mode) => { state.clip = { mode, src, label: data.source.label, dir: cur, paths: selPaths() }; f.sel = new Set(); render(); };
  const paste = () => act(async () => {
    const r = await api('POST', '/fm/transfer', { mode: clip.mode === 'cut' ? 'move' : 'copy', from: { src: clip.src, paths: clip.paths }, to: { src, path: cur } });
    if (clip.mode === 'cut') state.clip = null;
    return r;
  }, (r) => `${clip.mode === 'cut' ? 'Moved' : 'Copied'} ${r.done.length} item(s).`);

  // ---- actions on selection
  const zipSel = () => {
    const paths = selPaths(), one = sel().length === 1 ? sel()[0].name : (crumbs.at(-1) || 'archive');
    promptDialog('Create zip', 'Archive name', one.replace(/\.zip$/i, '') + '.zip', (name) => act(() => api('POST', '/fm/zip', { src, path: cur, paths, name }), (r) => `Created ${r.name}`));
  };
  const delSel = () => confirmDo(`Delete ${sel().length} selected item(s)? Folders are deleted with everything inside.`, () => act(() => api('POST', '/fm/delete', { src, paths: selPaths() }), (r) => `Deleted ${r.deleted} item(s).`));
  const unzipDialog = (e) => {
    const mode = h('select', null, h('option', { value: 'here' }, 'Extract here'), h('option', { value: 'folder' }, `Extract into a new folder "${e.name.replace(/\.zip$/i, '')}"`));
    const ow = h('input', { type: 'checkbox' });
    const d = dialog(`Unzip ${e.name}`, h('div', null, h('label', null, 'Where'), mode, h('label', { class: 'ck' }, ow, 'Overwrite existing files'),
      h('div', { class: 'row', style: 'margin-top:1rem' },
        h('button', { class: 'pri', onclick: () => { d.close(); act(() => api('POST', '/fm/unzip', { src, path: joinPath(cur, e.name), dest: cur, folder: mode.value === 'folder', overwrite: ow.checked }),
          (r) => `Extracted ${r.files} file(s)${r.skipped?.length ? `, skipped ${r.skipped.length} unsafe entr${r.skipped.length > 1 ? 'ies' : 'y'}` : ''}.`); } }, 'Unzip'),
        h('button', { onclick: () => d.close() }, 'Cancel'))));
  };

  const nameCell = (e) => {
    const badge = e.symlink ? h('span', { class: 'badge' }, e.target ? `link -> ${e.target}` : 'link') : null;
    const p = joinPath(cur, e.name);
    if (e.type === 'dir' || e.type === 'link') return h('td', null, h('a', { class: 'link', onclick: () => go(p) }, (e.type === 'dir' ? '[ ] ' : '') + e.name), badge);
    if (e.type === 'file') return h('td', null, h('a', { class: 'link', onclick: () => openViewer(e) }, e.name), badge);
    return h('td', null, e.name, badge);
  };
  function openViewer(e) {
    const p = joinPath(cur, e.name);
    const close = h('button', { onclick: () => d.close() }, 'Close');
    const dl = h('a', { class: 'btn', href: dlUrl(e.name) }, 'Download');
    const body = h('div', { class: 'mut' }, 'Loading...');
    const d = dialog(e.name, h('div', null, body, h('div', { class: 'row', style: 'margin-top:1rem' }, dl, close)));
    d.classList.add('wide');
    if (IMG_RE.test(e.name)) return body.replaceChildren(h('img', { src: dlUrl(e.name, true), style: 'max-width:100%;max-height:70vh;display:block;margin:auto' }));
    if (/\.pdf$/i.test(e.name)) return body.replaceChildren(h('a', { class: 'btn pri', href: dlUrl(e.name, true), target: '_blank', rel: 'noopener' }, 'Open PDF in a new tab'));
    api('GET', `/fm/read?${fq({ src, path: p })}`).then((r) => {
      const ta = h('textarea', { class: 'editor', spellcheck: false, readonly: !r.writable }, r.content);
      const st = h('span', { class: 'mut' }, `${bytes(r.size)}${r.writable ? '' : ' - read-only'}`);
      const save = h('button', { class: 'pri', disabled: !r.writable, onclick: async () => {
        save.disabled = true;
        try {
          const res = await fetch(`/api/fm/write?${fq({ src, path: p })}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: ta.value });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
          st.textContent = `Saved ${new Date().toLocaleTimeString()}`; st.style.color = 'var(--pri)';
        } catch (err) { st.textContent = err.message; st.style.color = 'var(--bad)'; }
        save.disabled = !r.writable;
      } }, 'Save');
      ta.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); save.click(); } });
      ta.addEventListener('input', () => { st.textContent = 'Modified (Ctrl+S to save)'; st.style.color = 'var(--warn)'; });
      body.replaceChildren(ta, h('div', { class: 'row', style: 'margin-top:.5rem' }, save, st));
      close.before(save, st); // keep Save reachable without scrolling
      body.querySelector('.row')?.remove();
    }, (err) => body.replaceChildren(flash(err.message.includes('binary') ? 'warn' : 'err', err.message)));
  }

  const allBox = h('input', { type: 'checkbox', checked: entries.length > 0 && entries.every((e) => f.sel.has(e.name)), onchange: (ev) => { f.sel = ev.target.checked ? new Set(entries.map((e) => e.name)) : new Set(); render(); } });
  const card = h('div', { class: 'card', id: 'fm-card' }, head,
    h('div', { class: 'row sp', style: 'margin:.6rem 0' },
      h('div', { class: 'row' },
        containerMode && h('select', { onchange: (ev) => pickSrc(ev.target.value), style: 'max-width:260px' }, ctrs.map((c) => h('option', { value: c.id, selected: c.id === src }, c.name))),
        h('span', null, h('a', { class: 'link', onclick: () => go('/') }, containerMode ? '/' : data.source.label), crumbs.map((c, i) => [' / ', h('a', { class: 'link', onclick: () => go('/' + crumbs.slice(0, i + 1).join('/')) }, c)]))),
      h('div', { class: 'row' },
        writable && [
          h('button', { onclick: () => promptDialog('New folder', 'Folder name', '', (v) => act(() => api('POST', '/fm/mkdir', { src, path: cur, name: v }))) }, '+ Folder'),
          h('button', { onclick: () => promptDialog('New file', 'File name', '', (v) => act(() => api('POST', '/fm/mkfile', { src, path: cur, name: v }))) }, '+ File'),
          h('button', { class: 'pri', onclick: () => fileIn.click() }, 'Upload files'), h('button', { onclick: () => dirIn.click() }, 'Upload folder'),
          h('label', { class: 'ck', style: 'margin:0' }, overwrite, 'overwrite'), fileIn, dirIn],
        clip && writable && h('button', { class: 'pri', onclick: paste }, `Paste ${clip.paths.length} (${clip.mode === 'cut' ? 'move' : 'copy'})`),
        !writable && h('span', { class: 'badge warn' }, 'read-only'),
        h('button', { onclick: () => render() }, 'Refresh'))),
    clip && h('div', { class: 'msg', style: 'padding:.4rem .8rem' }, `Clipboard: ${clip.mode} ${clip.paths.length} item(s) from ${clip.label}:${clip.dir} - open any folder (even another source) and press Paste. `,
      h('a', { class: 'link', onclick: () => { state.clip = null; render(); } }, 'clear')),
    f.sel.size > 0 && h('div', { class: 'row msg', style: 'padding:.4rem .8rem' }, h('b', null, `${f.sel.size} selected`),
      h('button', { onclick: () => setClip('copy') }, 'Copy'), writable && h('button', { onclick: () => setClip('cut') }, 'Cut'),
      writable && h('button', { onclick: zipSel }, 'Zip'), writable && h('button', { class: 'bad', onclick: delSel }, 'Delete'),
      h('button', { onclick: () => { f.sel = new Set(); render(); } }, 'Clear selection')),
    containerMode && h('p', { class: 'mut' }, 'Inside the running container (uses its ls/stat/mkdir/mv/cp/rm; zip and unzip are done by the panel). New files are created as root unless you edit an existing one (owner and permissions are kept).'),
    msg, progress,
    h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { style: 'width:1.5rem' }, allBox), sortTh('Name', 'name'), sortTh('Size', 'size'), sortTh('Created', 'birth'), sortTh('Modified', 'mtime'), h('th', null, 'Permissions'), h('th', null, ''))),
      h('tbody', null, cur !== '/' && h('tr', null, h('td'), h('td', { colspan: 6 }, h('a', { class: 'link', onclick: () => go('/' + crumbs.slice(0, -1).join('/')) }, '.. (up)'))),
        entries.map((e) => {
          const p = joinPath(cur, e.name);
          return h('tr', null,
            h('td', null, h('input', { type: 'checkbox', checked: f.sel.has(e.name), onchange: (ev) => { ev.target.checked ? f.sel.add(e.name) : f.sel.delete(e.name); render(); } })),
            nameCell(e), h('td', null, e.size == null ? '-' : bytes(e.size)),
            h('td', { class: 'mut', title: e.birth ? '' : 'Creation time is not recorded by this filesystem' }, fmtTime(e.birth)),
            h('td', { class: 'mut' }, e.mtime ? fmtTime(e.mtime) : (e.mtimeText || '-')),
            h('td', { class: 'mut' }, e.mode || '-', e.owner ? ` ${e.owner}` : ''),
            h('td', { class: 'row' },
              e.type === 'file' && h('button', { onclick: () => openViewer(e) }, 'View'),
              (e.type === 'file' || e.type === 'dir' || e.type === 'link') && h('a', { class: 'btn', href: dlUrl(e.name) }, e.type === 'dir' ? '.tar' : 'Download'),
              writable && h('button', { onclick: () => promptDialog('Rename', 'New name', e.name, (v) => act(() => api('POST', '/fm/rename', { src, path: p, newName: v }))) }, 'Rename'),
              writable && e.type === 'file' && isZip(e.name) && h('button', { onclick: () => unzipDialog(e) }, 'Unzip'),
              writable && h('button', { class: 'bad', onclick: () => confirmDo(`Delete ${e.name}${e.type === 'dir' ? ' and everything inside it' : ''}?`, () => act(() => api('POST', '/fm/delete', { src, paths: [p] }))) }, 'Delete')));
        }),
        entries.length === 0 && empty(7, 'Empty folder. Drop files or folders here to upload.')))));
  if (writable) { // drag & drop upload (files and folders)
    card.addEventListener('dragover', (ev) => { ev.preventDefault(); card.classList.add('drop'); });
    card.addEventListener('dragleave', (ev) => { if (ev.target === card) card.classList.remove('drop'); });
    card.addEventListener('drop', (ev) => { ev.preventDefault(); card.classList.remove('drop'); collectDropped(ev.dataTransfer).then((items) => (items.files.length || items.dirs.length) && upload(items)).catch((e) => toast(msg, 'err', e.message)); });
  }
  main.replaceChildren(card);
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
    force: h('input', { type: 'checkbox', checked: p.domain ? p.force_ssl : true }), hsts: h('input', { type: 'checkbox', checked: p.hsts }),
  };
  const picker = certPicker(certs, p.certificate_id); f.cert = picker.sel;
  const certRow = picker.box;
  const sslOpts = h('div', null, h('label', { class: 'ck' }, f.force, 'Force SSL (redirect HTTP to HTTPS)'), h('label', { class: 'ck' }, f.hsts, 'HSTS'));
  const sync = () => { certRow.hidden = f.ssl.value !== 'custom'; sslOpts.hidden = f.ssl.value === 'none'; };
  f.ssl.addEventListener('change', () => { sync(); if (f.ssl.value === 'custom' && !picker.count()) picker.add(); }); sync();
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

// ---- responsive tables: label every cell with its column header; below 720px the CSS turns rows into cards
function labelTables(root) {
  for (const t of root.querySelectorAll('table')) {
    const heads = [...t.querySelectorAll('thead th')].map((x) => x.textContent.replace(/[▲▼]/g, '').trim());
    if (!heads.length) continue;
    t.classList.add('cards');
    for (const tr of t.querySelectorAll('tbody tr')) {
      let i = 0;
      for (const td of tr.children) {
        td.dataset.label = td.colSpan > 1 ? '' : (heads[i] ?? ''); i += td.colSpan || 1;
        // several siblings in one cell (name + badge...) would become separate flex items in card mode: keep them together
        if (td.childNodes.length > 1 && !td.classList.contains('row') && td.colSpan === 1 && !(td.firstElementChild?.classList.contains('cell') && td.childNodes.length === 1)) {
          const box = document.createElement('div'); box.className = 'cell';
          box.append(...td.childNodes); td.append(box);
        }
      }
    }
  }
}
let labelTimer = null;
new MutationObserver(() => { clearTimeout(labelTimer); labelTimer = setTimeout(() => labelTables(document.body), 30); })
  .observe(document.body, { childList: true, subtree: true });

render();
