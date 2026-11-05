import http from 'node:http';
import os from 'node:os';

/** Minimal Docker Engine API client over the unix socket (or Windows named pipe). No dependencies. */
const socketPath = () => process.env.DOCKER_SOCKET || (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');

export class DockerError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function dockerRequest(method, path, { body, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      socketPath: socketPath(), method, path, timeout,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = buf.toString('utf8').trim();
          try { msg = JSON.parse(msg).message || msg; } catch { /* plain text */ }
          return reject(new DockerError(msg || `Docker error ${res.statusCode}`, [404, 409, 304].includes(res.statusCode) ? res.statusCode : 502));
        }
        resolve({ status: res.statusCode, buf, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new DockerError('Docker request timed out', 504)));
    req.on('error', (e) => reject(e instanceof DockerError ? e
      : new DockerError(`Docker is not reachable at ${socketPath()} (${e.code || e.message}). Is the socket mounted?`, 503)));
    if (payload) req.write(payload);
    req.end();
  });
}

export const dockerJson = async (method, path, opts) => {
  const { buf } = await dockerRequest(method, path, opts);
  return buf.length ? JSON.parse(buf.toString('utf8')) : null;
};

/** Docker multiplexes stdout/stderr into 8-byte-header frames unless the container has a TTY. */
export function demuxLogs(buf, tty = false) {
  if (tty) return buf.toString('utf8');
  let out = '', i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return out;
}

/** CPU% / memory / network from one `stats?stream=false` sample. */
export function summarizeStats(s) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const ncpu = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0;
  const m = s.memory_stats || {};
  const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
  const memUsed = Math.max(0, (m.usage || 0) - cache);
  const nets = Object.values(s.networks || {});
  return {
    cpu: Math.round(cpu * 10) / 10,
    memUsed, memLimit: m.limit || 0,
    netRx: nets.reduce((a, n) => a + n.rx_bytes, 0), netTx: nets.reduce((a, n) => a + n.tx_bytes, 0),
  };
}

/** The panel's own container id prefix (hostname) - used to refuse stopping/removing ourselves. */
export const selfId = () => os.hostname();
