// The door's registered sites and the servers behind them. Routes come from
// the shared server registry the door recorded (a door-mode server lists its
// proxy port and per-start secret there), so a door restart loses nothing.
// The door starts a stopped site by running that checkout's own `rer dev`
// through this package's launcher, with the site environment from its stored
// policy, and reads only its exit status (and, on failure, the error events of
// its private log); it never reads or holds a dev key.
import { spawn } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { changeDoorState, doorOrigin, doorProtocol, doorSite, readDoorState } from '../../cli/door.mjs';
import { ownRoot } from '../package-info.mjs';
import { liveServers } from '../registry.mjs';
import { siteEnvironment } from './policy.mjs';

const rerEntry = join(ownRoot, 'global/rer.mjs');
const startTimeoutMs = 15 * 60_000, failureShownMs = 30_000;

// A registered server's own status: whether it has finished starting.
function serverReady(record) {
 return new Promise(resolve => {
  const socket = createConnection(record.control);
  let text = '';
  socket.setTimeout(2000, () => socket.destroy());
  socket.on('connect', () => socket.end(JSON.stringify({ token: record.token, action: 'status' })));
  socket.on('data', chunk => { text += chunk; if (text.length > 16384) socket.destroy(); });
  socket.on('end', () => { try { const value = JSON.parse(text); resolve(value.token === record.token && value.ready === true); } catch { resolve(false); } });
  socket.on('error', () => resolve(false));
  socket.on('close', () => resolve(false));
 });
}

// { code, error }: listened for as soon as the child is spawned, because a
// spawn that fails (its folder gone) reports it on the next tick.
function exitOf(child) { return new Promise(resolve => { child.once('error', error => resolve({ code: 1, error })); child.once('exit', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1) })); }); }

// The `message` of the launcher's JSON error events, nothing else.
async function failureReason(path, from) {
 const lines = (await readFile(path, 'utf8')).slice(from).split('\n');
 const reasons = [];
 for (const line of lines) {
  if (!line.startsWith('{')) continue;
  try { const event = JSON.parse(line); if (event.event === 'error' && typeof event.message === 'string') reasons.push(event.message); } catch {}
 }
 return reasons.at(-1) ?? 'The launch stopped without a reason. Run rer dev in the checkout to see it.';
}

export function doorSites({ env, door, log = () => {} }) {
 const doorEnv = { ...env, RER_DOOR_DIR: door.directory }, serverEnv = { ...env, RER_SERVERS_DIR: door.serversDir };
 const starts = new Map(), failures = new Map();
 let records = { at: 0, list: [] }, registered = { at: 0, list: [] }, started;

 async function list(force = false) {
  if (force || Date.now() - registered.at > 1000) registered = { at: Date.now(), list: (await readDoorState(doorEnv))?.sites ?? [] };
  return registered.list;
 }
 async function running(force = false) {
  if (force || Date.now() - records.at > 1000) {
   const live = await liveServers(serverEnv);
   records = { at: Date.now(), list: await Promise.all(live.map(async record => ({ ...record, ready: await serverReady(record) }))) };
  }
  return records.list;
 }
 // Generations of the servers this door started (kept in the door state, so
 // they survive a door restart); only those may be stopped for capacity. A
 // draining door waits for its starts under way to record theirs (busy()).
 async function doorStarted() {
  started ??= new Set((await readDoorState(doorEnv))?.door?.started ?? []);
  return started;
 }
 // Liveness is read inside the state change, so a concurrent start's
 // generation, recorded a moment earlier, is never dropped as dead.
 async function remember(generation) {
  await changeDoorState(doorEnv, async state => {
   const live = new Set((await liveServers(serverEnv)).map(record => record.generation));
   state.door.started = [...new Set([...(state.door.started ?? []), generation])].filter(item => live.has(item));
   started = new Set(state.door.started);
  });
 }

 async function view(site, { force = false } = {}) {
  const record = (await running(force)).find(item => item.checkout === site.checkout);
  const doorUrl = doorOrigin(site.name, door.port);
  const result = { name: site.name, path: site.checkout, mode: record ? (record.door || doorSite(record.url) ? 'door' : 'direct') : site.mode === 'door' ? 'door' : 'direct', doorUrl };
  if (record?.door && record.door.v !== doorProtocol) return { ...result, state: 'failed', url: doorUrl, reason: `This checkout's server speaks door protocol ${record.door.v}; restart the door with the installed rer (rer door restart).` };
  // A door-mode server is routable once it has recorded its proxy and is ready.
  if (record?.ready && (record.door ? record.port : record.url && !doorSite(record.url))) {
   return { ...result, state: 'running', url: record.url, ...(record.door ? { proxyPort: record.port, secret: record.door.secret } : {}), record };
  }
  if (starts.has(site.name) || record) return { ...result, state: 'starting', url: result.mode === 'door' ? doorUrl : site.origin ?? doorUrl };
  const failure = failures.get(site.name);
  if (failure && Date.now() - failure.at < failureShownMs) return { ...result, state: 'failed', reason: failure.reason, url: doorUrl };
  return { ...result, state: 'stopped', url: result.mode === 'door' ? doorUrl : site.origin ?? doorUrl };
 }

 async function runLauncher(args, site, logPath) {
  const handle = await open(logPath, 'a', 0o600), from = (await handle.stat()).size;
  let child, exited;
  try { child = spawn(process.execPath, [rerEntry, ...args], { cwd: site.checkout, env: siteEnvironment(door, env), detached: true, stdio: ['ignore', handle.fd, handle.fd] }); exited = exitOf(child); }
  finally { await handle.close(); }
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, startTimeoutMs);
  const { code, error } = await exited;
  clearTimeout(timer);
  return { code, from, error };
 }
 const launchFailure = async (site, logPath, { from, error }) => error ? `rer could not run in ${site.checkout}: ${error.code ?? error.message}.` : failureReason(logPath, from);

 // A checkout whose folder was moved, renamed or deleted cannot start: say so
 // before admission, so nothing is stopped to make room for it.
 async function present(site) {
  const folder = await stat(site.checkout).catch(() => undefined);
  if (!folder?.isDirectory()) throw Error(`The checkout folder ${site.checkout} no longer exists, so ${site.name} was not started. If it moved, run rer dev in its new folder (or rer door add NEW_PATH): it keeps the name ${site.name}, its address and its sign-in. Otherwise unregister it with rer door remove ${site.name}.`);
 }

 // Admission is serial. Each start in turn counts the servers running, the
 // starts already admitted and the servers already being stopped for one, then
 // takes a free slot, or stops this door's own least recently active server
 // that no other start is stopping (never one someone started with rer dev),
 // or is refused naming what holds the cap. So concurrent visits (a browser
 // restoring many tabs) each get their own slot or a clear refusal, and never
 // stop the same server twice and then fail at the limit.
 const admitted = new Set(), evicting = new Set();
 let admission = Promise.resolve();
 function admit(site) {
  const turn = admission.then(() => reserve(site));
  admission = turn.catch(() => {});
  return turn;
 }
 async function reserve(site) {
  const live = (await running(true)).filter(record => !record.journey && record.checkout !== site.checkout);
  const cap = Math.min(door.policy.serverLimit, ...live.filter(record => record.explicit).map(record => record.limit));
  const staying = live.filter(record => !evicting.has(record.generation)), liveCheckouts = new Set(live.map(record => record.checkout));
  const starting = [...admitted].filter(checkout => checkout !== site.checkout && !liveCheckouts.has(checkout));
  if (staying.length + starting.length < cap) { admitted.add(site.checkout); return undefined; }
  const mine = await doorStarted();
  const victim = staying.filter(record => mine.has(record.generation) && !admitted.has(record.checkout)).sort((a, b) => (a.lastActivity ?? 0) - (b.lastActivity ?? 0))[0];
  if (!victim) throw Error([
   `The server limit is ${cap}, and every place is held by a server someone started with rer dev or by a start already under way, so none was stopped for ${site.name}:`,
   ...staying.map(record => `  ${record.mode} for ${record.checkout} (PID ${record.owner?.pid})${admitted.has(record.checkout) ? ', starting for another visit' : ', started with rer dev'}`),
   ...starting.map(checkout => `  starting ${checkout} for another visit`),
   'Stop one with rer dev --stop in its checkout, or raise the limit with rer door enable --server-limit N.',
  ].join('\n'));
  evicting.add(victim.generation); admitted.add(site.checkout);
  return victim;
 }
 async function evict(victim, site) {
  try {
   const owner = (await list()).find(item => item.checkout === victim.checkout) ?? { checkout: victim.checkout, name: 'evicted' };
   log(`stopping ${victim.checkout} (least recently active door-started server) to make room for ${site.name}`);
   const logPath = join(door.directory, 'logs', `${owner.name}.log`), run = await runLauncher([victim.mode, '--stop', '--cwd', victim.checkout], owner, logPath);
   if (run.code !== 0) throw Error(`The server limit is reached, and stopping ${victim.checkout} to make room failed: ${await launchFailure(owner, logPath, run)}`);
   await running(true);
  } finally { evicting.delete(victim.generation); }
 }

 async function start(site) {
  const logPath = join(door.directory, 'logs', `${site.name}.log`);
  let reserved = false;
  try {
   await present(site);
   const victim = await admit(site);
   reserved = true;
   if (victim) await evict(victim, site);
   log(`starting ${site.name} (${site.checkout})`);
   const run = await runLauncher(['dev', '--cwd', site.checkout, '--detach', '--json', '--door-start'], site, logPath);
   if (run.code !== 0) throw Error(await launchFailure(site, logPath, run));
   const record = (await running(true)).find(item => item.checkout === site.checkout);
   if (!record) throw Error('The site reported ready but is not in the server registry.');
   await remember(record.generation);
   failures.delete(site.name);
   log(`${site.name} is running`);
  } catch (error) {
   failures.set(site.name, { at: Date.now(), reason: error.message });
   log(`${site.name} did not start: ${error.message.split('\n')[0]}`);
  } finally { if (reserved) admitted.delete(site.checkout); starts.delete(site.name); records.at = 0; }
 }

 return {
  list, view, running,
  async views() { return Promise.all((await list()).map(site => view(site))); },
  // Begin a start unless one is already under way.
  ensureStarted(site) {
   if (!starts.has(site.name)) { failures.delete(site.name); starts.set(site.name, start(site)); }
   return starts.get(site.name);
  },
  invalidate() { records.at = 0; },
  busy() { return starts.size > 0; },
  // The names of the sites starting now (handed to the next door on a restart).
  pending() { return [...starts.keys()]; },
 };
}
