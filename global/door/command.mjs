// rer door: the opt-in front door. One process on one port serves every
// registered checkout at http://NAME.localhost:PORT, starting it on its first
// visit and stopping it when idle.
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { changeDoorState, checkoutIdentity, claimEntry, defaultDoorPort, doorOrigin, doorProtocol, doorSite, ensureToken, prepareDoorDirectory, readDoorState, runningDoor, saveCheckoutIdentity, verifyDoor } from '../../cli/door.mjs';
import { openUrl, readDevKey } from '../../cli/dev-identity.mjs';
import { descriptorProfile, dispatcher, unsupportedMessage } from '../checkout.mjs';
import { describeCheckout } from '../launch/facts.mjs';
import { ownManifest } from '../package-info.mjs';
import { DoorFailure, startDoor, stopDoor } from './control.mjs';
import { rebootNote } from './pages.mjs';
import { enabledPolicy } from './policy.mjs';
import { doorSites } from './sites.mjs';

export const doorHelp = `Usage: rer door VERB

The front door serves every registered checkout at http://NAME.localhost:PORT
from one process on one port. A checkout starts on its first visit in a browser
and stops when idle. It is opt-in for this computer.

  rer door enable [--port N] [--server-limit N] [--idle-timeout S]
                        Opt this computer in, record the policy and start the door.
                        Defaults: port 8700, 10 servers, 43200 s (12 hours) idle.
                        The policy and the RER_* variables in effect now are stored;
                        sites the door starts get those, never another shell's.
  rer door disable      Stop the door and opt this computer out.
  rer door start        Start the enabled door (needed after a reboot or logout).
  rer door stop         Stop the door. Running sites keep running until idle.
  rer door restart      Drain and restart the door; open tabs reconnect.
  rer door add [PATH ...]
                        Register checkouts (default: here) for lazy start, printing
                        each URL and, for a set-up door-mode checkout with dev
                        identity, a sign-in link that starts it and signs in.
  rer door remove NAME  Unregister one checkout. Its name stays reserved for it;
                        rer dev there, or rer door add, registers it again.
  rer door status [--json] [--links]
                        The door, its policy and every site with its state and URL;
                        --links adds sign-in links.

Fresh checkouts launched with rer dev while the door is enabled are set up at
their door URL. Move an existing one with rer dev --door (rer dev --direct moves
it back); rer dev --port N always serves directly.
`;

const out = text => process.stdout.write(text + '\n');
const err = text => process.stderr.write(text + '\n');

function flags(args, valued, booleans = []) {
 const result = { positional: [] };
 for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (valued.includes(arg)) { const value = args[++i]; if (value === undefined || value.startsWith('--')) throw new DoorFailure(2, `${arg} needs a value.`); result[arg] = value; }
  else if (booleans.includes(arg)) result[arg] = true;
  else if (arg.startsWith('-')) throw new DoorFailure(2, `Unsupported flag ${arg}. Run rer door --help.`);
  else result.positional.push(arg);
 }
 return result;
}

async function enabledState(env) {
 const state = await readDoorState(env);
 if (!state?.door?.enabled) throw new DoorFailure(3, 'The front door is not enabled on this computer. Enable it with: rer door enable');
 return state;
}

function runningLine(door, record) {
 return `Front door running at http://localhost:${record.port} (PID ${record.pid}, rer ${record.version}); limit ${door.policy.serverLimit} servers, idle stop after ${door.policy.idleSeconds} s.`;
}

// Replace a running door with a new one: the old one stops accepting, hands
// the starts under way to the new one and gives up its port at once, then
// finishes its requests; the new one carries those starts on (each one's own
// rer dev waits for it before its key is printed) and open tabs reconnect.
// `change` edits the state between the two (rer door enable's new policy).
async function replaceDoor(env, change) {
 const running = await runningDoor(env);
 if (running) await changeDoorState(env, state => { if (state.door) state.door.restarting = Date.now(); });
 try {
  const stopped = running ? await stopDoor(env, { released: true }) : undefined;
  if (change) await changeDoorState(env, change);
  const { door } = await startDoor(env);
  return { stopped, door };
 } finally { if (running) await changeDoorState(env, state => { if (state.door) delete state.door.restarting; }); }
}

async function enable(args, env) {
 const given = flags(args, ['--port', '--server-limit', '--idle-timeout']);
 if (given.positional.length) throw new DoorFailure(2, 'rer door enable takes only flags. Run rer door --help.');
 const chosen = enabledPolicy({ port: given['--port'], serverLimit: given['--server-limit'], idleTimeout: given['--idle-timeout'] }, env);
 const previous = (await readDoorState(env))?.door;
 const port = chosen.port ?? previous?.port ?? defaultDoorPort;
 const directory = await prepareDoorDirectory(env);
 await ensureToken(directory);
 const { door: record } = await replaceDoor(env, state => {
  state.door = { protocol: doorProtocol, enabled: true, port, policy: chosen.policy, directory: chosen.directory, serversDir: chosen.serversDir, environment: chosen.environment, started: state.door?.started ?? [], ...(state.door?.handoff ? { handoff: state.door.handoff } : {}), ...(state.door?.restarting ? { restarting: state.door.restarting } : {}), enabledAt: new Date().toISOString() };
 });
 out(runningLine({ policy: chosen.policy }, record));
 if (previous?.port && previous.port !== port) out(`Checkouts already moved to the door keep their saved port ${previous.port}; move each again with rer dev --direct, then rer dev --door.`);
 out(`Register checkouts with rer door add PATH. ${rebootNote.replace(/<\/?code>/g, '')}`);
 return 0;
}

async function disable(args, env) {
 if (args.length) throw new DoorFailure(2, 'rer door disable takes no arguments.');
 const stopped = await stopDoor(env);
 if (await readDoorState(env)) await changeDoorState(env, state => { if (state.door) state.door.enabled = false; });
 out(`${stopped ? `Stopped the front door (PID ${stopped.pid}). ` : ''}The front door is disabled on this computer. Registered checkouts stay registered; rer door enable turns it back on.`);
 return 0;
}

async function start(env) {
 const state = await enabledState(env);
 const { door: record, already } = await startDoor(env);
 out(already ? `The front door is already running (PID ${record.pid}).` : runningLine(state.door, record));
 return 0;
}

async function stop(env) {
 const stopped = await stopDoor(env);
 out(stopped ? `Stopped the front door (PID ${stopped.pid}). Sites it started keep running until idle; rer door start brings it back.` : 'The front door is not running.');
 return 0;
}

async function restart(env) {
 const state = await enabledState(env);
 const { stopped, door: record } = await replaceDoor(env);
 out(`${stopped ? `Drained the front door (PID ${stopped.pid}); open tabs reconnect. ` : ''}${runningLine(state.door, record)}`);
 return 0;
}

// The sign-in link for a set-up door-mode checkout with dev identity, after the
// door proves it is this account's. It carries the checkout's dev key in its
// fragment: printed for the person, never given to the door.
async function signInLink(site, port) {
 if (site.mode !== 'door') return undefined;
 let key; try { key = await readDevKey(site.path); } catch { return undefined; }
 return key ? openUrl(doorOrigin(site.name, port), key, { path: '/__dev/key', as: 'owner' }) : undefined;
}

// A pin from before the door does not describe its saved origin; its direct
// link is the AUTH_ORIGIN its settings file holds (read only for the link).
async function oldPinOrigin(root, described) {
 try {
  const text = await readFile(join(root, described.local?.settings?.[0] ?? '.dev.vars'), 'utf8');
  const origin = /^AUTH_ORIGIN=(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)\s*$/m.exec(text)?.[1];
  return origin ?? null;
 } catch { return null; }
}

class NameHeld extends Error {}

async function add(args, env) {
 const given = flags(args, []);
 const state = await enabledState(env), port = state.door.port;
 let verified, verifyError;
 try { verified = await verifyDoor(env, port); } catch (error) { verifyError = error; }
 let skipped = 0;
 for (const path of given.positional.length ? given.positional : ['.']) {
  let root;
  try { root = await realpath(resolve(path)); } catch { out(`skipped ${path}: no such folder`); skipped++; continue; }
  const facts = descriptorProfile(join(root, 'OPERATIONS.json'));
  if (facts.profile !== 'first-party') {
   out(`skipped ${path}: ${facts.profile === 'independent' ? 'an independent project; the front door serves first-party checkouts' : facts.profile === 'unreadable' ? 'no readable OPERATIONS.json, so not a first-party checkout' : unsupportedMessage(root, facts.version)}`);
   skipped++; continue;
  }
  let described;
  try { described = await describeCheckout(root, dispatcher(root).entry, env); } catch (failure) { out(`skipped ${path}: rer describe fails here: ${failure.message.split('\n')[0]}`); skipped++; continue; }
  const saved = described.local && 'origin' in described.local ? described.local.origin : await oldPinOrigin(root, described), site = saved && doorSite(saved), mode = site && site.port === port ? 'door' : 'direct';
  // A door-mode checkout's saved origin names its site, so it registers under
  // that name or not at all; another checkout keeps a name it holds.
  // A moved or renamed checkout is found by the identity its folder holds.
  let name, id;
  try {
   ({ name, id } = await changeDoorState(env, state => {
    const { entry, holder } = claimEntry(state, root, site?.name, checkoutIdentity(root));
    // Thrown, so the state is left as it was.
    if (mode === 'door' && entry.name !== site.name) throw new NameHeld(holder?.checkout ?? `this checkout under ${entry.name}`);
    Object.assign(entry, { mode, door: Boolean(described.door) });
    if (saved && mode === 'direct') entry.origin = saved; else delete entry.origin;
    return { name: entry.name, id: entry.id };
   }));
   await saveCheckoutIdentity(root, id);
  } catch (error) {
   if (!(error instanceof NameHeld)) throw error;
   out(`skipped ${path}: its saved origin names ${site.name}.localhost, which the front door has registered for ${error.message}. Give it its own name with rer dev --direct, then rer dev --door, in ${root}.`);
   skipped++; continue;
  }
  const url = doorOrigin(name, port);
  out(`${name}  ${url}  (${mode === 'door' ? 'door mode' : `direct${saved ? ` at ${saved}` : ''}; opening the door URL starts it and redirects there`})  ${root}`);
  if (mode === 'door' && described.local?.devIdentity) {
   const link = verified && await signInLink({ name, path: root, mode }, port);
   if (link) out(`  sign in: ${link}`);
   else if (verifyError) out(`  no sign-in link: ${verifyError.message}`);
  }
 }
 return skipped && skipped === (given.positional.length || 1) ? 3 : 0;
}

// The checkout keeps its name reserved: its saved origin still names it, so no
// other checkout may take it, and its own next rer dev (or rer door add)
// registers it again.
async function remove(args, env) {
 const given = flags(args, []);
 if (given.positional.length !== 1) throw new DoorFailure(2, 'Usage: rer door remove NAME');
 const [name] = given.positional;
 const removed = await changeDoorState(env, state => { const site = state.sites.find(item => item.name === name && !item.removed); if (site) site.removed = true; return site; });
 if (!removed) { err(`No checkout is registered as ${name}. rer door status lists them.`); return 3; }
 out(`Unregistered ${name} (${removed.checkout}). Its checkout and any running server are untouched, and the name stays reserved for it: rer dev there, or rer door add, registers it again.`);
 return 0;
}

async function status(args, env) {
 const given = flags(args, [], ['--json', '--links']);
 if (given.positional.length) throw new DoorFailure(2, 'Usage: rer door status [--json] [--links]');
 const state = await readDoorState(env), record = await runningDoor(env), version = record?.version ?? ownManifest().version;
 const door = state?.door;
 const views = door ? await doorSites({ env, door }).views() : [];
 let linkNote;
 if (given['--links'] && door) {
  try {
   await verifyDoor(env, door.port);
   for (const view of views) { const link = await signInLink(view, door.port); if (link) view.signIn = link; }
  } catch (error) { linkNote = error.message; }
 }
 const sites = views.map(view => ({ name: view.name, path: view.path, mode: view.mode, state: view.state === 'failed' ? 'stopped' : view.state, url: view.url, ...(view.proxyPort && view.state === 'running' ? { proxyPort: view.proxyPort } : {}), ...(view.signIn ? { signIn: view.signIn } : {}) }));
 const result = { running: Boolean(record), enabled: Boolean(door?.enabled), port: door?.port ?? record?.port ?? null, pid: record?.pid ?? null, version, policy: door ? { serverLimit: door.policy.serverLimit, idleSeconds: door.policy.idleSeconds } : null, sites };
 if (given['--json']) { out(JSON.stringify({ ...result, ...(linkNote ? { linksUnavailable: linkNote } : {}), ...(!record && door?.enabled ? { note: 'After a reboot or logout the front door needs rer door start.' } : {}) })); return 0; }
 if (!door) { out('The front door is not enabled on this computer. Enable it with: rer door enable'); return 0; }
 out(record ? runningLine(door, record) : door.enabled ? `The front door is enabled on port ${door.port} but not running. Start it with: rer door start` : 'The front door is disabled on this computer. Enable it with: rer door enable');
 if (sites.length) {
  const width = Math.max(4, ...sites.map(site => site.name.length));
  out(`${'NAME'.padEnd(width)}  STATE     MODE    URL`);
  for (const site of sites) {
   out(`${site.name.padEnd(width)}  ${site.state.padEnd(8)}  ${site.mode.padEnd(6)}  ${site.url}${site.proxyPort ? `  (proxy 127.0.0.1:${site.proxyPort})` : ''}`);
   if (site.signIn) out(`${' '.repeat(width)}  sign in: ${site.signIn}`);
  }
 } else out('No checkouts are registered. Add one with: rer door add PATH');
 if (linkNote) out(`No sign-in links: ${linkNote}`);
 if (!record && door.enabled) out('After a reboot or logout the front door needs rer door start (or any rer dev in a door-mode checkout).');
 return 0;
}

export async function doorCommand(args, env = process.env) {
 // A reader that stops early (rer door status | grep -q) is not a failure.
 process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
 const [verb, ...rest] = args;
 if (!verb || ['--help', '-h', 'help'].includes(verb) || rest.includes('--help')) { process.stdout.write(doorHelp); return 0; }
 const verbs = { enable, disable, add, remove, status, start: (_, e) => start(e), stop: (_, e) => stop(e), restart: (_, e) => restart(e) };
 if (!Object.hasOwn(verbs, verb)) { err(`Unknown rer door command: ${verb}. Run rer door --help.`); return 2; }
 if (['start', 'stop', 'restart'].includes(verb) && rest.length) { err(`rer door ${verb} takes no arguments.`); return 2; }
 try { return await verbs[verb](rest, env); }
 catch (error) { if (error instanceof DoorFailure || error.exitCode) { err(error.message); return error.exitCode ?? 1; } throw error; }
}
