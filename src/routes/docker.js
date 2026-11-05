import { Router } from 'express';
import { audit } from '../db.js';
import { requireAdmin } from '../auth.js';
import { ValidationError } from '../validate.js';
import { StringDecoder } from 'node:string_decoder';
import { dockerRequest, dockerJson, dockerStream, createDemuxer, demuxLogs, summarizeStats, selfId, DockerError } from '../docker.js';
import { cfs } from './containerfs.js';

/**
 * Docker management (admin only). WARNING: access to docker.sock is root-equivalent on the host,
 * which is why every route here requires the admin role and every change is audited.
 */
export const docker = Router();
docker.use(requireAdmin);

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/;
const idParam = (v) => { if (!ID_RE.test(v)) throw new ValidationError('Invalid id'); return v; };
const isSelf = (id) => { const me = selfId(); return id.length >= 4 && (me.startsWith(id) || id.startsWith(me)); };
const q = (o) => new URLSearchParams(o).toString();

const portsText = (ports = []) => [...new Set(ports.map((p) =>
  p.PublicPort ? `${p.IP && p.IP !== '0.0.0.0' && p.IP !== '::' ? p.IP + ':' : ''}${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`))].join(', ');

docker.get('/info', async (req, res) => {
  const [v, i] = await Promise.all([dockerJson('GET', '/version'), dockerJson('GET', '/info')]);
  res.json({
    version: v.Version, apiVersion: v.ApiVersion, os: i.OperatingSystem, kernel: i.KernelVersion,
    containers: i.Containers, running: i.ContainersRunning, paused: i.ContainersPaused, stopped: i.ContainersStopped, images: i.Images,
  });
});

// ---------- containers ----------
docker.get('/containers', async (req, res) => {
  const list = await dockerJson('GET', '/containers/json?all=1');
  res.json(list.map((c) => ({
    id: c.Id.slice(0, 12), name: (c.Names[0] || '').replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status,
    ports: portsText(c.Ports), created: c.Created, project: c.Labels?.['com.docker.compose.project'] || '',
    networks: Object.keys(c.NetworkSettings?.Networks || {}), self: isSelf(c.Id),
  })).sort((a, b) => a.name.localeCompare(b.name)));
});

// Live CPU/memory/network for running containers (each sample takes ~1s, done in parallel)
docker.get('/containers/stats', async (req, res) => {
  const running = (await dockerJson('GET', '/containers/json')).slice(0, 50);
  const out = {};
  await Promise.all(running.map(async (c) => {
    try { out[c.Id.slice(0, 12)] = summarizeStats(await dockerJson('GET', `/containers/${c.Id}/stats?stream=false`, { timeout: 15_000 })); }
    catch { /* container vanished */ }
  }));
  res.json(out);
});

docker.get('/containers/:id', async (req, res) => {
  const c = await dockerJson('GET', `/containers/${idParam(req.params.id)}/json`);
  res.json({
    id: c.Id.slice(0, 12), name: c.Name.replace(/^\//, ''), image: c.Config.Image, created: c.Created, state: c.State,
    cmd: c.Config.Cmd, env: c.Config.Env, restartPolicy: c.HostConfig.RestartPolicy?.Name,
    mounts: (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Source || m.Name, destination: m.Destination, rw: m.RW })),
    networks: Object.fromEntries(Object.entries(c.NetworkSettings?.Networks || {}).map(([k, n]) => [k, n.IPAddress])),
    ports: c.NetworkSettings?.Ports,
  });
});

docker.get('/containers/:id/logs', async (req, res) => {
  const id = idParam(req.params.id);
  const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 200, 1), 5000);
  const info = await dockerJson('GET', `/containers/${id}/json`);
  const { buf } = await dockerRequest('GET', `/containers/${id}/logs?${q({ stdout: 1, stderr: 1, tail, timestamps: 1 })}`, { timeout: 15_000 });
  res.json({ logs: demuxLogs(buf, !!info.Config?.Tty) });
});

const tailParam = (v) => (v === 'all' ? 'all' : Math.min(Math.max(parseInt(v, 10) || 200, 1), 100000));

// Live log follow as Server-Sent Events: each event is a JSON array of new lines. Works for stopped containers too (history, then end).
docker.get('/containers/:id/logs/stream', async (req, res) => {
  const id = idParam(req.params.id);
  const info = await dockerJson('GET', `/containers/${id}/json`);
  const src = await dockerStream('GET', `/containers/${id}/logs?${q({ stdout: 1, stderr: 1, follow: 1, tail: tailParam(req.query.tail), timestamps: 1 })}`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const dec = new StringDecoder('utf8'), demux = createDemuxer(!!info.Config?.Tty);
  let carry = '';
  const send = (event, data) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  demux.on('data', (b) => {
    carry += dec.write(b);
    const lines = carry.split('\n'); carry = lines.pop();
    if (lines.length) send(null, lines);
  });
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const done = () => { clearInterval(beat); src.destroy(); };
  src.on('end', () => { if (carry) send(null, [carry]); send('end', {}); res.end(); clearInterval(beat); });
  src.on('error', done);
  req.on('close', done);
  src.pipe(demux);
});

// Download the whole log as a text file (streamed, any size)
docker.get('/containers/:id/logs/download', async (req, res) => {
  const id = idParam(req.params.id);
  const info = await dockerJson('GET', `/containers/${id}/json`);
  const src = await dockerStream('GET', `/containers/${id}/logs?${q({ stdout: 1, stderr: 1, tail: tailParam(req.query.tail || 'all'), timestamps: 1 })}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${(info.Name || id).replace(/[^\w.-]/g, '_')}.log"`);
  audit(req.user.id, 'docker_logs_download', id);
  req.on('close', () => src.destroy());
  src.pipe(createDemuxer(!!info.Config?.Tty)).pipe(res);
});

// File manager inside a container
docker.use('/containers/:id/fs', cfs);

const ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', pause: 'pause', unpause: 'unpause', kill: 'kill' };
docker.post('/containers/:id/:action', async (req, res) => {
  const id = idParam(req.params.id);
  const action = ACTIONS[req.params.action];
  if (!action) throw new ValidationError('Unknown action');
  if (isSelf(id) && action !== 'start') throw new ValidationError('The panel cannot stop or restart its own container');
  try { await dockerRequest('POST', `/containers/${id}/${action}`, { timeout: 60_000 }); }
  catch (e) { if (!(e instanceof DockerError && e.status === 304)) throw e; } // 304 = already in that state
  audit(req.user.id, `docker_${action}`, id);
  res.json({ ok: true });
});

docker.delete('/containers/:id', async (req, res) => {
  const id = idParam(req.params.id);
  if (isSelf(id)) throw new ValidationError('The panel cannot remove its own container');
  await dockerRequest('DELETE', `/containers/${id}?${q({ force: req.query.force === '1' ? 1 : 0, v: req.query.volumes === '1' ? 1 : 0 })}`);
  audit(req.user.id, 'docker_rm', id);
  res.json({ ok: true });
});

// Run a new container: { image, name?, ports:["8080:80"], env:["K=V"], volumes:["/host:/ctr:ro"], restart, network, command }
docker.post('/containers', async (req, res) => {
  const b = req.body || {};
  const image = String(b.image || '').trim();
  if (!IMAGE_RE.test(image)) throw new ValidationError('Invalid image name');
  if (b.name && !NAME_RE.test(b.name)) throw new ValidationError('Invalid container name');
  const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);

  const exposed = {}, bindings = {};
  for (const p of lines(b.ports)) {
    const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(p);
    if (!m || +m[2] > 65535 || +m[3] > 65535) throw new ValidationError(`Invalid port mapping: ${p} (use hostPort:containerPort)`);
    const key = `${m[3]}/${m[4] || 'tcp'}`;
    exposed[key] = {};
    (bindings[key] ||= []).push({ HostPort: m[2], ...(m[1] && { HostIp: m[1] }) });
  }
  const env = lines(b.env);
  for (const e of env) if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) throw new ValidationError(`Invalid env var: ${e} (use KEY=value)`);
  const binds = lines(b.volumes);
  for (const v of binds) if (!/^[^:]+:\/[^:]*(:(ro|rw))?$/.test(v)) throw new ValidationError(`Invalid volume: ${v} (use /host/path:/container/path[:ro])`);
  const restart = b.restart || 'no';
  if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(restart)) throw new ValidationError('Invalid restart policy');
  if (b.network && !NAME_RE.test(b.network)) throw new ValidationError('Invalid network');

  const spec = {
    Image: image, Env: env, ExposedPorts: exposed,
    ...(b.command && { Cmd: String(b.command).match(/"[^"]*"|'[^']*'|\S+/g).map((s) => s.replace(/^(["'])(.*)\1$/, '$2')) }),
    HostConfig: { PortBindings: bindings, Binds: binds, RestartPolicy: { Name: restart }, ...(b.network && { NetworkMode: b.network }) },
  };
  const create = () => dockerJson('POST', `/containers/create${b.name ? '?' + q({ name: b.name }) : ''}`, { body: spec });
  let created;
  try { created = await create(); }
  catch (e) {
    if (!(e instanceof DockerError && e.status === 404)) throw e; // 404 = image missing locally: pull, retry once
    await pullImage(image);
    created = await create();
  }
  await dockerRequest('POST', `/containers/${created.Id}/start`);
  audit(req.user.id, 'docker_run', `${image} ${b.name || created.Id.slice(0, 12)}`);
  res.status(201).json({ id: created.Id.slice(0, 12) });
});

// ---------- images ----------
async function pullImage(image) {
  const [name, tag] = image.includes('@') ? [image, null] : (() => { const i = image.lastIndexOf(':'); return i > image.lastIndexOf('/') ? [image.slice(0, i), image.slice(i + 1)] : [image, 'latest']; })();
  const { buf } = await dockerRequest('POST', `/images/create?${q({ fromImage: name, ...(tag && { tag }) })}`, { timeout: 15 * 60_000 });
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) { // NDJSON progress; errors arrive in-band
    try { const j = JSON.parse(line); if (j.error) throw new DockerError(j.error, 502); } catch (e) { if (e instanceof DockerError) throw e; }
  }
}

docker.get('/images', async (req, res) => {
  const [imgs, ctrs] = await Promise.all([dockerJson('GET', '/images/json'), dockerJson('GET', '/containers/json?all=1')]);
  const used = new Set(ctrs.map((c) => c.ImageID));
  res.json(imgs.map((i) => ({
    id: i.Id.replace('sha256:', '').slice(0, 12), tags: i.RepoTags || [], size: i.Size, created: i.Created, inUse: used.has(i.Id),
  })).sort((a, b) => b.created - a.created));
});

docker.post('/images/pull', async (req, res) => {
  const image = String(req.body?.image || '').trim();
  if (!IMAGE_RE.test(image)) throw new ValidationError('Invalid image name');
  await pullImage(image);
  audit(req.user.id, 'docker_pull', image);
  res.json({ ok: true });
});

docker.post('/images/prune', async (req, res) => {
  const r = await dockerJson('POST', '/images/prune?filters=' + encodeURIComponent(JSON.stringify({ dangling: ['true'] })));
  audit(req.user.id, 'docker_image_prune', `${r.ImagesDeleted?.length || 0} removed`);
  res.json({ removed: r.ImagesDeleted?.length || 0, reclaimed: r.SpaceReclaimed || 0 });
});

docker.delete('/images/:id', async (req, res) => {
  const id = idParam(req.params.id);
  await dockerRequest('DELETE', `/images/${id}?${q({ force: req.query.force === '1' ? 1 : 0 })}`);
  audit(req.user.id, 'docker_rmi', id);
  res.json({ ok: true });
});

// ---------- volumes / networks ----------
docker.get('/volumes', async (req, res) => {
  const [v, ctrs] = await Promise.all([dockerJson('GET', '/volumes'), dockerJson('GET', '/containers/json?all=1')]);
  const used = new Set(ctrs.flatMap((c) => (c.Mounts || []).map((m) => m.Name)));
  res.json((v.Volumes || []).map((x) => ({ name: x.Name, driver: x.Driver, mountpoint: x.Mountpoint, created: x.CreatedAt, inUse: used.has(x.Name) })));
});
docker.delete('/volumes/:name', async (req, res) => {
  await dockerRequest('DELETE', `/volumes/${idParam(req.params.name)}`);
  audit(req.user.id, 'docker_volume_rm', req.params.name);
  res.json({ ok: true });
});
docker.get('/networks', async (req, res) => {
  const n = await dockerJson('GET', '/networks');
  res.json(n.map((x) => ({
    id: x.Id.slice(0, 12), name: x.Name, driver: x.Driver, scope: x.Scope, internal: x.Internal,
    subnet: x.IPAM?.Config?.[0]?.Subnet || '', containers: Object.keys(x.Containers || {}).length,
  })));
});
