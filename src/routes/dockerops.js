import { Router } from 'express';
import { db, audit } from '../db.js';
import { ValidationError } from '../validate.js';
import { dockerRequest, dockerJson, pullImage, normalizeServer, registryHost, DockerError } from '../docker.js';
import { encrypt } from '../secrets.js';
import { NAME_RE, IMAGE_RE, idParam, isSelf } from './dockerutil.js';

/**
 * Docker networks, per-container networking, image pull / update (recreate), and registry credentials.
 * Mounted inside the admin-only docker router, so every route here already requires the admin role.
 */
export const dockerops = Router();
const enc = encodeURIComponent;
const BUILTIN = ['bridge', 'host', 'none'];
const SUBNET_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
const stripMask = (ip) => String(ip || '').replace(/\/\d+$/, '');

// ------------------------------------------------------------------ networks

const netInfo = (n) => ({
  id: n.Id.slice(0, 12), name: n.Name, driver: n.Driver, scope: n.Scope, internal: !!n.Internal, ipv6: !!n.EnableIPv6,
  subnets: (n.IPAM?.Config || []).filter((c) => c.Subnet).map((c) => ({ subnet: c.Subnet, gateway: c.Gateway || '' })),
  builtin: BUILTIN.includes(n.Name), project: n.Labels?.['com.docker.compose.project'] || '',
  containers: Object.entries(n.Containers || {}).map(([id, c]) => ({ id: id.slice(0, 12), name: c.Name, ipv4: stripMask(c.IPv4Address), ipv6: stripMask(c.IPv6Address), mac: c.MacAddress || '' }))
    .sort((a, b) => a.name.localeCompare(b.name)),
});

dockerops.get('/networks', async (req, res) => {
  const all = await dockerJson('GET', '/networks');
  // the list call omits members; inspect each one (few networks) so the container counts are real
  const full = await Promise.all(all.map((n) => dockerJson('GET', `/networks/${n.Id}`).catch(() => n)));
  res.json(full.map(netInfo).sort((a, b) => a.name.localeCompare(b.name)));
});

dockerops.get('/networks/:id', async (req, res) => {
  res.json(netInfo(await dockerJson('GET', `/networks/${idParam(req.params.id)}`)));
});

dockerops.post('/networks', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!NAME_RE.test(name)) throw new ValidationError('Invalid network name (letters, digits, _ . -)');
  if (BUILTIN.includes(name)) throw new ValidationError(`"${name}" is a built-in network name`);
  const spec = { Name: name, Driver: 'bridge', Internal: !!b.internal, Labels: { 'created-by': 'caddy-admin' } };
  if (b.subnet) {
    if (!SUBNET_RE.test(b.subnet)) throw new ValidationError('Subnet must look like 172.30.0.0/24');
    const cfg = { Subnet: b.subnet };
    if (b.gateway) { if (!IP_RE.test(b.gateway)) throw new ValidationError('Invalid gateway'); cfg.Gateway = b.gateway; }
    spec.IPAM = { Driver: 'default', Config: [cfg] };
  }
  const r = await dockerJson('POST', '/networks/create', { body: spec });
  audit(req.user.id, 'docker_network_create', name);
  res.status(201).json({ id: r.Id.slice(0, 12) });
});

dockerops.delete('/networks/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const n = await dockerJson('GET', `/networks/${id}`);
  if (BUILTIN.includes(n.Name)) throw new ValidationError('Built-in networks cannot be removed');
  await dockerRequest('DELETE', `/networks/${id}`); // Docker refuses while containers are still attached
  audit(req.user.id, 'docker_network_rm', n.Name);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ networks of one container

const endpoints = (info) => Object.entries(info.NetworkSettings?.Networks || {}).map(([name, n]) => ({
  name, id: (n.NetworkID || '').slice(0, 12), ip: n.IPAddress || '', ipv6: n.GlobalIPv6Address || '', gateway: n.Gateway || '', mac: n.MacAddress || '',
  aliases: (n.Aliases || []).filter((a) => a !== info.Id.slice(0, 12)), static: !!n.IPAMConfig,
}));

dockerops.get('/containers/:id/networks', async (req, res) => {
  const info = await dockerJson('GET', `/containers/${idParam(req.params.id)}/json`);
  res.json({ mode: info.HostConfig?.NetworkMode || '', networks: endpoints(info) });
});

dockerops.post('/containers/:id/networks/connect', async (req, res) => {
  const id = idParam(req.params.id), b = req.body || {};
  const net = String(b.network || '').trim();
  if (!NAME_RE.test(net)) throw new ValidationError('Choose a network');
  if (['host', 'none'].includes(net)) throw new ValidationError(`Containers cannot be added to the "${net}" network this way`);
  const ep = {};
  const aliases = list(b.aliases);
  for (const a of aliases) if (!ALIAS_RE.test(a)) throw new ValidationError(`Invalid alias: ${a}`);
  if (aliases.length) ep.Aliases = aliases;
  if (b.ipv4) { if (!IP_RE.test(b.ipv4)) throw new ValidationError('Invalid IPv4 address'); ep.IPAMConfig = { IPv4Address: b.ipv4 }; }
  await dockerRequest('POST', `/networks/${enc(net)}/connect`, { body: { Container: id, EndpointConfig: ep } });
  audit(req.user.id, 'docker_net_connect', `${id} -> ${net}`);
  res.json({ ok: true });
});

dockerops.post('/containers/:id/networks/disconnect', async (req, res) => {
  const id = idParam(req.params.id), b = req.body || {};
  const net = String(b.network || '').trim();
  if (!NAME_RE.test(net)) throw new ValidationError('Choose a network');
  const info = await dockerJson('GET', `/containers/${id}/json`);
  if (isSelf(info.Id)) throw new ValidationError('The panel cannot change its own networks (it would lose access to Caddy and to you)');
  await dockerRequest('POST', `/networks/${enc(net)}/disconnect`, { body: { Container: info.Id, Force: !!b.force } });
  audit(req.user.id, 'docker_net_disconnect', `${id} x ${net}`);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ pull / update (recreate) a container

function imageRef(info) {
  const img = info.Config?.Image || '';
  if (!IMAGE_RE.test(img) || /^sha256:/.test(img) || /^[0-9a-f]{12,64}$/.test(img)) {
    throw new ValidationError('This container was created from an image ID, so there is no tag to pull');
  }
  return img;
}

async function pullAndCompare(info) {
  const image = imageRef(info);
  await pullImage(image);
  const fresh = await dockerJson('GET', `/images/${enc(image)}/json`);
  return { image, imageId: fresh.Id, changed: fresh.Id !== info.Image };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Create-body for a replacement container: the old container's own settings, minus whatever merely came from
 * the OLD image (env, cmd, labels...) so the new image's defaults apply. Anonymous volumes are re-attached by
 * name so their data survives. All networks (aliases, static IPs) are kept.
 */
export function buildCreateBody(info, imageCfg = {}) {
  const c = info.Config || {}, d = imageCfg, shortId = info.Id.slice(0, 12);
  const hc = JSON.parse(JSON.stringify(info.HostConfig || {}));
  const bound = new Set([...(hc.Binds || []).map((b) => b.split(':')[1]), ...(hc.Mounts || []).map((m) => m.Target)]);
  for (const m of info.Mounts || []) {
    if (m.Type === 'volume' && /^[0-9a-f]{64}$/.test(m.Name || '') && !bound.has(m.Destination)) {
      (hc.Binds ||= []).push(`${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
    }
  }
  const body = {
    Image: c.Image,
    ...(c.Hostname && c.Hostname !== shortId && { Hostname: c.Hostname }),
    ...(c.Domainname && { Domainname: c.Domainname }),
    ...(c.User && !same(c.User, d.User) && { User: c.User }),
    AttachStdin: c.AttachStdin, AttachStdout: c.AttachStdout, AttachStderr: c.AttachStderr,
    Tty: c.Tty, OpenStdin: c.OpenStdin, StdinOnce: c.StdinOnce,
    Env: (c.Env || []).filter((e) => !(d.Env || []).includes(e)),
    ...(!same(c.Cmd, d.Cmd) && { Cmd: c.Cmd }),
    ...(!same(c.Entrypoint, d.Entrypoint) && { Entrypoint: c.Entrypoint }),
    ...(c.WorkingDir && !same(c.WorkingDir, d.WorkingDir) && { WorkingDir: c.WorkingDir }),
    ...(c.Healthcheck && !same(c.Healthcheck, d.Healthcheck) && { Healthcheck: c.Healthcheck }),
    ...(c.StopSignal && !same(c.StopSignal, d.StopSignal) && { StopSignal: c.StopSignal }),
    ...(c.StopTimeout != null && { StopTimeout: c.StopTimeout }),
    ...(c.ExposedPorts && !same(c.ExposedPorts, d.ExposedPorts) && { ExposedPorts: c.ExposedPorts }),
    Labels: Object.fromEntries(Object.entries(c.Labels || {}).filter(([k, v]) => d.Labels?.[k] !== v)),
    HostConfig: hc,
  };
  const mode = hc.NetworkMode || '';
  const nets = Object.entries(info.NetworkSettings?.Networks || {});
  if (nets.length && !['host', 'none'].includes(mode) && !mode.startsWith('container:')) {
    body.NetworkingConfig = {
      EndpointsConfig: Object.fromEntries(nets.map(([name, n]) => [name, {
        Aliases: (n.Aliases || []).filter((a) => a !== shortId), IPAMConfig: n.IPAMConfig || undefined,
        Links: n.Links || undefined, DriverOpts: n.DriverOpts || undefined,
      }])),
    };
  }
  return body;
}

async function createContainer(name, body) {
  const url = `/containers/create?name=${enc(name)}`;
  try { return await dockerJson('POST', url, { body }); }
  catch (e) {
    const eps = body.NetworkingConfig?.EndpointsConfig || {};
    if (!(e instanceof DockerError) || Object.keys(eps).length < 2 || !/network/i.test(e.message)) throw e;
    const [[firstName, first], ...rest] = Object.entries(eps); // older daemons: one network at create time, connect the rest
    const created = await dockerJson('POST', url, { body: { ...body, NetworkingConfig: { EndpointsConfig: { [firstName]: first } } } });
    for (const [net, ep] of rest) await dockerRequest('POST', `/networks/${enc(net)}/connect`, { body: { Container: created.Id, EndpointConfig: ep } });
    return created;
  }
}

/** Replace a container with a new one built from the same settings. Rolls back to the old one on any failure. */
async function recreate(info) {
  const id = info.Id, name = info.Name.replace(/^\//, ''), wasRunning = !!info.State?.Running;
  const old = await dockerJson('GET', `/images/${enc(info.Image)}/json`).catch(() => null);
  const body = buildCreateBody(info, old?.Config || {});
  const parked = `${name}_old_${Date.now().toString(36)}`;
  if (wasRunning) { try { await dockerRequest('POST', `/containers/${id}/stop`, { timeout: 120_000 }); } catch (e) { if (!(e instanceof DockerError && e.status === 304)) throw e; } }
  await dockerRequest('POST', `/containers/${id}/rename?name=${enc(parked)}`);
  let created;
  try {
    created = await createContainer(name, body);
    if (wasRunning) await dockerRequest('POST', `/containers/${created.Id}/start`);
  } catch (e) { // put everything back the way it was
    if (created) await dockerRequest('DELETE', `/containers/${created.Id}?force=1`).catch(() => {});
    await dockerRequest('POST', `/containers/${id}/rename?name=${enc(name)}`).catch(() => {});
    if (wasRunning) await dockerRequest('POST', `/containers/${id}/start`).catch(() => {});
    throw e;
  }
  await dockerRequest('DELETE', `/containers/${id}?v=0`).catch(() => {}); // v=0: keep the old container's volumes
  return created.Id.slice(0, 12);
}

dockerops.post('/containers/:id/pull', async (req, res) => {
  const info = await dockerJson('GET', `/containers/${idParam(req.params.id)}/json`);
  const r = await pullAndCompare(info);
  audit(req.user.id, 'docker_container_pull', `${info.Name.replace(/^\//, '')} ${r.image}${r.changed ? ' (newer image)' : ''}`);
  res.json({ image: r.image, changed: r.changed, imageId: r.imageId.replace('sha256:', '').slice(0, 12) });
});

// { pull: true (default), force: false } - recreate with the latest image if there is one (or always with force)
dockerops.post('/containers/:id/update', async (req, res) => {
  const info = await dockerJson('GET', `/containers/${idParam(req.params.id)}/json`);
  if (isSelf(info.Id)) throw new ValidationError('The panel cannot replace its own container - pull the new image and run: docker compose up -d');
  let changed = false;
  if (req.body?.pull !== false) changed = (await pullAndCompare(info)).changed;
  if (!req.body?.force && !changed) return res.json({ recreated: false, reason: 'The container already runs the latest image' });
  const id = await recreate(info);
  audit(req.user.id, 'docker_container_update', `${info.Name.replace(/^\//, '')} ${info.Config.Image}${req.body?.force && !changed ? ' (forced)' : ''}`);
  res.json({ recreated: true, id, changed });
});

// ------------------------------------------------------------------ registry credentials (for pulling private images, e.g. Nexus)

dockerops.get('/registries', (req, res) => {
  res.json(db.prepare('SELECT id, server, username, created_at FROM registries ORDER BY server').all()); // never the password
});

dockerops.post('/registries', async (req, res) => {
  const b = req.body || {};
  const server = normalizeServer(b.server || '');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(server)) throw new ValidationError('Registry must be a host name like docker.can4net.com or host:port');
  const username = String(b.username || '').trim(), password = String(b.password || '');
  if (!username || username.length > 200 || !password || password.length > 2000) throw new ValidationError('Username and password are required');
  if (!b.skipVerify) { // ask the Docker daemon to log in, so a typo is caught now instead of at the next pull
    const hub = ['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(server);
    try { await dockerJson('POST', '/auth', { body: { username, password, serveraddress: hub ? 'https://index.docker.io/v1/' : server } }); }
    catch (e) { throw new ValidationError(`Registry login failed: ${e.message}`); }
  }
  db.prepare('INSERT INTO registries(server,username,password_enc) VALUES(?,?,?) ON CONFLICT(server) DO UPDATE SET username=excluded.username, password_enc=excluded.password_enc')
    .run(server, username, encrypt(password));
  audit(req.user.id, 'docker_registry_save', `${server} (${username})`);
  res.status(201).json({ ok: true, server, host: registryHost(`${server}/x`) });
});

dockerops.delete('/registries/:id', (req, res) => {
  const r = db.prepare('SELECT server FROM registries WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM registries WHERE id=?').run(Number(req.params.id));
  audit(req.user.id, 'docker_registry_rm', r.server);
  res.json({ ok: true });
});
