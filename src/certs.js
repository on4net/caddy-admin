import crypto from 'node:crypto';
import tls from 'node:tls';
import { config } from './config.js';

/** Validate an uploaded cert+key pair; returns { domains, expiresAt }. Throws on invalid input. */
export function inspectCertificate(certPem, keyPem) {
  let x509, key;
  try { x509 = new crypto.X509Certificate(certPem); } catch { throw new Error('Certificate is not valid PEM'); }
  try { key = crypto.createPrivateKey(keyPem); } catch { throw new Error('Private key is not valid PEM (encrypted keys are not supported)'); }
  if (!x509.checkPrivateKey(key)) throw new Error('Private key does not match the certificate');
  const expiresAt = new Date(x509.validTo);
  if (expiresAt < new Date()) throw new Error('Certificate has already expired');

  const domains = new Set();
  for (const m of (x509.subjectAltName || '').matchAll(/DNS:([^,\s]+)/g)) domains.add(m[1].toLowerCase());
  const cn = /CN=([^\n,]+)/.exec(x509.subject)?.[1];
  if (cn && !domains.size) domains.add(cn.toLowerCase());
  return { domains: [...domains], expiresAt: expiresAt.toISOString() };
}

/** True if a cert domain (maybe wildcard) covers host. */
export function coversDomain(certDomain, host) {
  if (certDomain === host) return true;
  if (certDomain.startsWith('*.')) {
    const rest = host.split('.').slice(1).join('.');
    return rest === certDomain.slice(2);
  }
  return false;
}

/**
 * Ask the running Caddy which certificate it actually serves for a domain
 * (TLS handshake against the local HTTPS port, SNI = domain).
 */
export function probeCertificate(domain, { port = config.caddyHttpsPort, host = config.caddyHost, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, servername: domain, rejectUnauthorized: false, timeout }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      if (!c?.valid_to) return resolve({ ok: false, error: 'No certificate presented' });
      const expires = new Date(c.valid_to);
      resolve({
        ok: true,
        issuer: c.issuer?.O || c.issuer?.CN || '',
        subject: c.subject?.CN || '',
        validFrom: new Date(c.valid_from).toISOString(),
        expiresAt: expires.toISOString(),
        daysLeft: Math.floor((expires - Date.now()) / 86_400_000),
        trusted: sock.authorized, // false is expected for 'internal' / self-signed
      });
    });
    sock.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}
