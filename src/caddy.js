import { db, getSetting } from './db.js';
import { config } from './config.js';

const parse = (r) => ({ ...r, domains: JSON.parse(r.domains) });

/**
 * Build a full Caddy JSON config from DB state. Pure function of its inputs
 * (hosts, certs, settings) so it can be unit tested without Caddy.
 *
 * Layout (same idea as Nginx Proxy Manager):
 *  - srv_http  (:80)  : plain hosts, and redirect-to-https for force_ssl hosts
 *  - srv_https (:443) : hosts with ssl_mode != none
 *  - Caddy's own automatic redirects are disabled; we do redirects explicitly
 *    so "force SSL" is a per-host choice. ACME HTTP-01 still works on :80.
 *  - letsencrypt -> ACME automation policy, internal -> Caddy local CA,
 *    custom -> uploaded PEM loaded into the tls app (ACME skipped for it).
 */
export function buildConfig({ hosts, certs, acmeEmail, acmeCa, panel = null }) {
  const httpRoutes = [];
  const httpsRoutes = [];
  const policies = [];
  const loadPem = [];
  const skipCerts = [];
  const plainDomains = [];
  const certById = new Map(certs.map((c) => [c.id, c]));
  const usedCerts = new Set();

  // the panel's own domain is just another proxied host (first, so it wins any overlap)
  for (const h of [...(panel ? [panel] : []), ...hosts].filter((x) => x.enabled)) {
    const match = [{ host: h.domains }];
    const proxy = reverseProxy(h);
    const ssl = h.ssl_mode !== 'none';

    if (!ssl) {
      plainDomains.push(...h.domains);
      httpRoutes.push({ match, handle: [proxy], terminal: true });
      continue;
    }
    httpsRoutes.push({
      match,
      handle: [...(h.hsts ? [hstsHandler()] : []), proxy],
      terminal: true,
    });
    httpRoutes.push({
      match,
      handle: h.force_ssl ? [redirectHandler()] : [proxy],
      terminal: true,
    });

    if (h.ssl_mode === 'letsencrypt') {
      const issuer = { module: 'acme', ...(acmeEmail && { email: acmeEmail }), ...(acmeCa && { ca: acmeCa }) };
      policies.push({ subjects: h.domains, issuers: [issuer] });
    } else if (h.ssl_mode === 'internal') {
      policies.push({ subjects: h.domains, issuers: [{ module: 'internal' }] });
    } else if (h.ssl_mode === 'custom') {
      const c = certById.get(h.certificate_id);
      if (!c) throw new Error(`Host ${h.domains.join(',')} references a missing certificate`);
      skipCerts.push(...h.domains);
      if (!usedCerts.has(c.id)) {
        usedCerts.add(c.id);
        loadPem.push({ certificate: c.cert_pem, key: c.key_pem, tags: [`cert-${c.id}`] });
      }
    }
  }

  const servers = {};
  if (httpRoutes.length) servers.srv_http = { listen: [':80'], routes: httpRoutes, automatic_https: { disable_redirects: true, ...(plainDomains.length && { skip: [...new Set(plainDomains)] }) } };
  if (httpsRoutes.length) {
    servers.srv_https = {
      listen: [':443'],
      routes: httpsRoutes,
      automatic_https: { disable_redirects: true, ...(skipCerts.length && { skip_certificates: [...new Set(skipCerts)] }) },
    };
  }

  const cfg = { apps: { http: { servers } } };
  if (policies.length || loadPem.length) {
    cfg.apps.tls = {};
    if (policies.length) cfg.apps.tls.automation = { policies };
    if (loadPem.length) cfg.apps.tls.certificates = { load_pem: loadPem };
  }
  return cfg;
}

function reverseProxy(h) {
  const handler = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `${h.forward_host}:${h.forward_port}` }],
  };
  if (h.forward_scheme === 'https') {
    handler.transport = { protocol: 'http', tls: h.skip_upstream_verify ? { insecure_skip_verify: true } : {} };
  }
  return handler;
}
const hstsHandler = () => ({
  handler: 'headers',
  response: { set: { 'Strict-Transport-Security': ['max-age=31536000; includeSubDomains'] } },
});
const redirectHandler = () => ({
  handler: 'static_response',
  status_code: 308,
  headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
});

/** The panel's own domain (Settings -> Panel domain) as a host definition, or null if not configured. */
export function panelHost() {
  const domain = getSetting('panel_domain');
  if (!domain) return null;
  const [host, port] = (config.panelUpstream || `127.0.0.1:${config.port}`).split(/:(?=[^:]*$)/);
  return {
    domains: [domain], forward_scheme: 'http', forward_host: host, forward_port: Number(port) || config.port,
    ssl_mode: getSetting('panel_ssl_mode', 'letsencrypt'), certificate_id: Number(getSetting('panel_cert_id')) || null,
    force_ssl: getSetting('panel_force_ssl', '1') === '1', hsts: getSetting('panel_hsts', '0') === '1', enabled: 1,
  };
}

export function loadState() {
  return {
    panel: panelHost(),
    hosts: db.prepare('SELECT * FROM proxy_hosts ORDER BY id').all().map(parse),
    certs: db.prepare('SELECT * FROM certificates').all(),
    acmeEmail: getSetting('acme_email'),
    acmeCa: getSetting('acme_ca'),
  };
}

export class CaddyError extends Error {
  constructor(message, { unreachable = false } = {}) { super(message); this.unreachable = unreachable; }
}

async function admin(path, opts = {}) {
  let res;
  try {
    // Caddy's admin API enforces an origin check; Node's fetch sends an empty Origin, which it rejects.
    res = await fetch(config.caddyAdmin + path, {
      signal: AbortSignal.timeout(10_000),
      ...opts,
      headers: { Origin: config.caddyAdmin, ...opts.headers },
    });
  } catch (e) {
    throw new CaddyError(`Cannot reach Caddy admin API at ${config.caddyAdmin} (${e.cause?.code || e.message})`, { unreachable: true });
  }
  if (!res.ok) throw new CaddyError(`Caddy rejected the request (${res.status}): ${(await res.text()).trim().slice(0, 500)}`);
  return res;
}

/** Push DB state to a running Caddy. Throws CaddyError. */
export async function applyConfig() {
  const cfg = buildConfig(loadState());
  // Replace only the `apps` subtree: the `admin` section (listen address / allowed origins)
  // must survive, or the panel would lock itself out of Caddy. Caddy applies this atomically.
  await admin('/config/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg.apps) });
  return cfg;
}

export async function caddyStatus() {
  try {
    const res = await admin('/config/');
    const live = await res.json();
    return { reachable: true, servers: Object.keys(live?.apps?.http?.servers || {}) };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}
