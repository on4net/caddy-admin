const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$|^\[[0-9a-f:]+\]$/i;

export class ValidationError extends Error {}
const bad = (m) => { throw new ValidationError(m); };

export function parseDomains(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(/[\s,]+/))
    .map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (!list.length) bad('At least one domain is required');
  for (const d of list) if (!DOMAIN_RE.test(d)) bad(`Invalid domain: ${d}`);
  return [...new Set(list)];
}

/** Validate + normalise a proxy host payload into DB column values. */
export function parseProxyHost(b) {
  const scheme = b.forward_scheme ?? 'http';
  if (!['http', 'https'].includes(scheme)) bad('forward_scheme must be http or https');
  const fhost = String(b.forward_host || '').trim();
  if (!HOST_RE.test(fhost)) bad('Invalid forward host');
  const port = Number(b.forward_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad('Invalid forward port');
  const ssl = b.ssl_mode ?? 'none';
  if (!['none', 'letsencrypt', 'internal', 'custom'].includes(ssl)) bad('Invalid ssl_mode');
  const certId = ssl === 'custom' ? Number(b.certificate_id) : null;
  if (ssl === 'custom' && !Number.isInteger(certId)) bad('certificate_id is required for custom SSL');
  const sslOn = ssl !== 'none';
  return {
    domains: JSON.stringify(parseDomains(b.domains)),
    forward_scheme: scheme,
    forward_host: fhost,
    forward_port: port,
    ssl_mode: ssl,
    certificate_id: certId,
    force_ssl: sslOn && b.force_ssl ? 1 : 0,
    hsts: sslOn && b.hsts ? 1 : 0,
    skip_upstream_verify: b.skip_upstream_verify ? 1 : 0,
    enabled: b.enabled === false ? 0 : 1,
  };
}

export function parseEmail(e) {
  const s = String(e || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) bad('Invalid email');
  return s;
}
export function parsePassword(p) {
  if (typeof p !== 'string' || p.length < 8) bad('Password must be at least 8 characters');
  return p;
}
