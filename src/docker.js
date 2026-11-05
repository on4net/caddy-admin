import http from 'node:http';
import os from 'node:os';
import { Transform } from 'node:stream';

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

/** Same as demuxLogs but keeps stdout and stderr apart (for commands whose stdout we parse). */
export function demuxSplit(buf) {
  let stdout = '', stderr = '', i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    const text = buf.subarray(i + 8, i + 8 + len).toString('utf8');
    if (buf[i] === 2) stderr += text; else stdout += text;
    i += 8 + len;
  }
  return { stdout, stderr };
}

/**
 * Streaming variant of dockerRequest: resolves with the response stream (status < 400) so big or endless
 * bodies (log follow, archives) are never buffered. `body` may be a string, Buffer or Readable. No timeout by default.
 */
export function dockerStream(method, path, { body, headers = {}, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const isStream = body && typeof body.pipe === 'function';
    const payload = body === undefined || isStream ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const req = http.request({
      socketPath: socketPath(), method, path, timeout,
      headers: { ...(payload != null && { 'Content-Length': Buffer.byteLength(payload) }), ...headers },
    }, (res) => {
      if (res.statusCode < 400) return resolve(res);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let msg = Buffer.concat(chunks).toString('utf8').trim();
        try { msg = JSON.parse(msg).message || msg; } catch { /* plain text */ }
        reject(new DockerError(msg || `Docker error ${res.statusCode}`, [404, 409].includes(res.statusCode) ? res.statusCode : 502));
      });
    });
    req.on('timeout', () => req.destroy(new DockerError('Docker request timed out', 504)));
    req.on('error', (e) => reject(e instanceof DockerError ? e
      : new DockerError(`Docker is not reachable at ${socketPath()} (${e.code || e.message}). Is the socket mounted?`, 503)));
    if (isStream) { body.on('error', (e) => req.destroy(e)); body.pipe(req); } else { if (payload != null) req.write(payload); req.end(); }
  });
}

/** Incremental demultiplexer for Docker's 8-byte-framed log/exec streams (TTY streams are raw: pass-through). */
export function createDemuxer(tty = false) {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _enc, cb) {
      if (tty) return cb(null, chunk);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let off = 0;
      while (pending.length - off >= 8) {
        const len = pending.readUInt32BE(off + 4);
        if (pending.length - off - 8 < len) break; // incomplete frame: wait for more
        this.push(pending.subarray(off + 8, off + 8 + len));
        off += 8 + len;
      }
      pending = pending.subarray(off);
      cb();
    },
  });
}

/** Run a command in a running container (no TTY) and wait for it. Pass argv as an array - never a shell string. */
export async function execRun(containerId, cmd, { user, timeout = 30_000 } = {}) {
  const ex = await dockerJson('POST', `/containers/${containerId}/exec`, {
    body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, ...(user && { User: user }) },
  });
  const { buf } = await dockerRequest('POST', `/exec/${ex.Id}/start`, { body: { Detach: false, Tty: false }, timeout });
  const info = await dockerJson('GET', `/exec/${ex.Id}/json`);
  return { exitCode: info.ExitCode, ...demuxSplit(buf) };
}

/** Interactive TTY exec: returns the hijacked raw duplex socket (stdin/stdout) of the exec instance. */
export async function execInteractive(containerId, { cmd, user, cols = 80, rows = 24 }) {
  const ex = await dockerJson('POST', `/containers/${containerId}/exec`, {
    body: { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: ['TERM=xterm-256color'], Cmd: cmd, ...(user && { User: user }) },
  });
  const payload = JSON.stringify({ Detach: false, Tty: true });
  const { socket, head } = await new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: socketPath(), method: 'POST', path: `/exec/${ex.Id}/start`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    req.on('upgrade', (_res, sock, h) => resolve({ socket: sock, head: h }));
    req.on('response', (res) => { // daemon refused the upgrade: surface its message
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => reject(new DockerError(Buffer.concat(chunks).toString('utf8').trim() || `exec failed (${res.statusCode})`, 502)));
    });
    req.on('error', (e) => reject(new DockerError(`Docker is not reachable (${e.code || e.message})`, 503)));
    req.end(payload);
  });
  await execResize(ex.Id, cols, rows);
  return { execId: ex.Id, socket, head };
}

export const execResize = (execId, cols, rows) =>
  dockerRequest('POST', `/exec/${execId}/resize?h=${rows}&w=${cols}`).catch(() => {}); // resize is best effort
