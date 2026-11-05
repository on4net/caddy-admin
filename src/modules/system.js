import os from 'node:os';
import fs from 'node:fs';
import { fileRoots } from '../files.js';

/**
 * Server monitoring: CPU, memory, network throughput, disk usage + a short in-memory history for charts.
 *
 * In Docker the panel runs with `pid: host`, so /proc/1/net/dev is the *host's* network namespace
 * (a plain /proc/net/dev would only show the container's own interface).
 */
const HOST_PROC = process.env.HOST_PROC || '/proc';
const HISTORY_MAX = Number(process.env.MONITOR_HISTORY_POINTS || 120);
const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 3000);
const VIRTUAL_IF = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|tun|tap)/;

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  return { idle, total };
}

/** Cumulative bytes per interface, or null when /proc is unavailable (e.g. running on Windows). */
export function readNetDev() {
  for (const p of [`${HOST_PROC}/1/net/dev`, `${HOST_PROC}/net/dev`]) {
    try {
      const out = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n').slice(2)) {
        const [name, rest] = line.split(':');
        if (!rest) continue;
        const f = rest.trim().split(/\s+/).map(Number);
        out[name.trim()] = { rx: f[0], tx: f[8] };
      }
      if (Object.keys(out).length) return out;
    } catch { /* try next */ }
  }
  return null;
}

export function readDisks() {
  const spec = (process.env.MONITOR_DISKS || '/|System').split(',').map((s) => s.split('|'));
  const list = spec.map(([p, label]) => ({ path: p.trim(), label: (label || p).trim() }));
  for (const r of fileRoots()) list.push({ path: r.dir, label: r.name });
  const seen = new Set(), out = [];
  for (const d of list) {
    try {
      const dev = fs.statSync(d.path).dev;
      const s = fs.statfsSync(d.path);
      const total = s.blocks * s.bsize;
      if (!total || seen.has(dev)) continue; // same filesystem listed twice
      seen.add(dev);
      const free = s.bavail * s.bsize;
      const used = total - s.bfree * s.bsize;
      out.push({ label: d.label, path: d.path, total, used, free, percent: Math.round((used / total) * 100) });
    } catch { /* path not present */ }
  }
  return out;
}

let prevCpu = cpuTimes();
let prevNet = null; // { t, byIf }
let last = null;
const history = [];

function memory() {
  const total = os.totalmem(), free = os.freemem();
  return { total, used: total - free, free, percent: Math.round(((total - free) / total) * 100) };
}

/** Take one sample, update history. Called by the sampler timer (and lazily by /system). */
export function sample() {
  const now = cpuTimes();
  const dTotal = now.total - prevCpu.total;
  const cpuPercent = dTotal > 0 ? Math.round((1 - (now.idle - prevCpu.idle) / dTotal) * 100) : (last?.cpuPercent ?? 0);
  prevCpu = now;

  let net = null;
  const dev = readNetDev();
  if (dev) {
    const t = Date.now();
    const phys = Object.entries(dev).filter(([n]) => !VIRTUAL_IF.test(n));
    const total = phys.reduce((a, [, v]) => ({ rx: a.rx + v.rx, tx: a.tx + v.tx }), { rx: 0, tx: 0 });
    let rxRate = 0, txRate = 0;
    const ifaces = {};
    if (prevNet) {
      const dt = (t - prevNet.t) / 1000;
      if (dt > 0) {
        rxRate = Math.max(0, (total.rx - prevNet.total.rx) / dt);
        txRate = Math.max(0, (total.tx - prevNet.total.tx) / dt);
        for (const [n, v] of phys) {
          const p = prevNet.byIf[n];
          if (p) ifaces[n] = { rxRate: Math.max(0, (v.rx - p.rx) / dt), txRate: Math.max(0, (v.tx - p.tx) / dt) };
        }
      }
    }
    prevNet = { t, total, byIf: dev };
    net = { rxRate, txRate, rxTotal: total.rx, txTotal: total.tx, interfaces: Object.fromEntries(phys.map(([n, v]) => [n, { rxTotal: v.rx, txTotal: v.tx, ...ifaces[n] }])) };
  }

  const mem = memory();
  last = { t: Date.now(), cpuPercent, memPercent: mem.percent, net };
  history.push({ t: last.t, cpu: cpuPercent, mem: mem.percent, rx: net?.rxRate ?? null, tx: net?.txRate ?? null });
  if (history.length > HISTORY_MAX) history.shift();
  return last;
}

export function startSampler() {
  sample();
  setInterval(sample, INTERVAL_MS).unref();
}

export function systemStats() {
  if (!last || Date.now() - last.t > INTERVAL_MS * 3) sample(); // sampler not running (tests / first call)
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSec: Math.floor(os.uptime()),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || '',
    cpuPercent: last.cpuPercent,
    loadAvg: os.loadavg(),
    memory: memory(),
    network: last.net, // null when not measurable on this platform
    disks: readDisks(),
  };
}

export const systemHistory = () => history.slice();
