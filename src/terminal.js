import { WebSocketServer } from 'ws';
import { audit } from './db.js';
import { userFromSession } from './auth.js';
import { execInteractive, execResize } from './docker.js';

/**
 * Browser terminal: WebSocket  /api/docker/containers/:id/exec?cols=&rows=&user=&shell=auto|sh|bash
 * bridges xterm.js to an interactive `docker exec` with a TTY.
 *   client -> server:  binary frame = keystrokes;  text frame = JSON control {"t":"resize","cols":N,"rows":N}
 *   server -> client:  binary frames = terminal output
 * Security: admin session cookie only (never API tokens), same-origin check against cross-site WebSocket
 * hijacking, session cap, idle timeout, audit entry per session. A shell in a container is root-equivalent
 * for that container, hence admin-only.
 */
const URL_RE = /^\/api\/docker\/containers\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/exec(?:\?(.*))?$/;
const MAX_SESSIONS = 10;
const IDLE_MS = Number(process.env.EXEC_IDLE_MIN || 30) * 60_000;
const SHELLS = {
  auto: ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
  sh: ['/bin/sh'], bash: ['/bin/bash'],
};
let sessions = 0;

const reject = (socket, code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
const clamp = (n, lo, hi, d) => { n = parseInt(n, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

export function attachTerminal(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req, socket, head) => {
    const m = URL_RE.exec(req.url);
    if (!m) return reject(socket, 404, 'Not Found');
    const origin = req.headers.origin;
    if (origin) { // browsers always send Origin on WebSocket handshakes
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
      if (!ok) return reject(socket, 403, 'Forbidden');
    }
    const user = userFromSession(req);
    if (!user) return reject(socket, 401, 'Unauthorized');
    if (user.role !== 'admin') return reject(socket, 403, 'Forbidden');
    if (sessions >= MAX_SESSIONS) return reject(socket, 429, 'Too Many Requests');
    const query = new URLSearchParams(m[2] || '');
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, m[1], query, user));
  });
}

async function bridge(ws, containerId, query, user) {
  const cols = clamp(query.get('cols'), 10, 500, 80), rows = clamp(query.get('rows'), 3, 200, 24);
  const execUser = query.get('user') || '';
  if (execUser && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(execUser)) return ws.close(1008, 'invalid user');
  const cmd = SHELLS[query.get('shell')] || SHELLS.auto;

  sessions++;
  let docker, closed = false;
  const cleanup = () => { if (closed) return; closed = true; sessions--; clearInterval(ping); clearTimeout(idle); docker?.socket.destroy(); };
  let idle;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => ws.close(4000, 'idle timeout'), IDLE_MS); };
  const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000); // keeps proxies from dropping the tunnel
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  try {
    docker = await execInteractive(containerId, { cmd, user: execUser || undefined, cols, rows });
  } catch (e) {
    if (ws.readyState === ws.OPEN) { ws.send(Buffer.from(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`)); ws.close(1011, 'exec failed'); }
    return cleanup();
  }
  if (closed) return docker.socket.destroy();
  audit(user.id, 'docker_exec', `${containerId}${execUser ? ` as ${execUser}` : ''}`);
  touch();
  if (docker.head?.length) ws.send(docker.head);
  docker.socket.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d));
  docker.socket.on('close', () => { if (ws.readyState === ws.OPEN) ws.close(1000, 'process exited'); cleanup(); });
  docker.socket.on('error', () => ws.close(1011, 'docker error'));
  ws.on('message', (data, isBinary) => {
    touch();
    if (isBinary) return docker.socket.write(data);
    try {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'resize') execResize(docker.execId, clamp(msg.cols, 10, 500, cols), clamp(msg.rows, 3, 200, rows));
    } catch { /* ignore malformed control frames */ }
  });
}
