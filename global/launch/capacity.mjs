// Person defaults and the server-limit check, applied by the launcher on every
// pin. A pin from before Base's person defaults (2 servers, 1800 s, and a cap
// set by the lowest limit any running server recorded) gets 10 servers and 12
// hours unless the person chose otherwise. The 1-minute-load guard belongs to
// the fleet's own environment: a person's start never waits or is refused for
// load alone, so an unset threshold becomes an unbounded one for old pins.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveServers, stopCommand } from '../registry.mjs';
import { LaunchFailure } from './failure.mjs';

export const personDefaults = { limit: 10, idleSeconds: 43200 };
const unboundedLoad = '1000000';
// The verbs that start a server or enter the job queue on every pin.
export const personVerbs = new Set(['dev', 'preview', 'install', 'setup', 'build', 'verify', 'deploy', 'export', 'import']);

// How the pinned dispatcher counts servers, and which person defaults it lacks.
// describe's `defaults` (from rer-cli-2) is authoritative: the launcher supplies
// a person default only where the pin's own is lower, so a current pin never
// records a limit nobody set. Before it, a pin whose registry exports its
// default limit already has the person defaults and binds only explicit limits;
// older pins have neither.
export async function pinPolicy(root, mode, described) {
 const own = described?.defaults;
 if (own) return { supply: { limit: !(own.serverLimit >= personDefaults.limit), idle: !(own.idleSeconds >= personDefaults.idleSeconds) }, explicitOnly: true, limit: own.serverLimit ?? personDefaults.limit };
 if (mode !== 'vendored') return { supply: { limit: false, idle: false }, explicitOnly: true, limit: personDefaults.limit };
 const registry = join(root, 'scripts/base-cli/cli/server-registry.mjs');
 const exported = existsSync(registry) ? await import(pathToFileURL(registry).href) : {};
 return 'defaultServerLimit' in exported
  ? { supply: { limit: false, idle: false }, explicitOnly: true, limit: exported.defaultServerLimit }
  : { supply: { limit: true, idle: true }, explicitOnly: false, limit: 2 };
}

export function personEnvironment(env, args, pin) {
 const added = {};
 if (pin.supply.limit && env.RER_SERVER_LIMIT === undefined) added.RER_SERVER_LIMIT = String(personDefaults.limit);
 if (pin.supply.idle && env.RER_SERVER_IDLE_SECONDS === undefined && !args.includes('--idle-timeout')) added.RER_SERVER_IDLE_SECONDS = String(personDefaults.idleSeconds);
 if (env.RER_SERVERS_LOAD_THRESHOLD === undefined) added.RER_SERVERS_LOAD_THRESHOLD = unboundedLoad;
 if (env.RER_JOBS_LOAD_THRESHOLD === undefined) added.RER_JOBS_LOAD_THRESHOLD = unboundedLoad;
 return added;
}

const listing = record => `  ${record.mode} on port ${record.port ?? '(starting)'} in ${record.checkout} (PID ${record.owner?.pid})\n    stop it with: ${stopCommand(record)}`;

// Refuse in seconds, before any install or setup, when the pinned dispatcher
// would refuse the start for the server limit. Returns this checkout's own
// running server when there is one.
export async function checkCapacity(checkout, env, pin) {
 const running = await liveServers(env);
 const own = running.find(record => record.checkout === checkout);
 if (own) return { own };
 if (env.RER_SERVER_JOURNEY === '1') return {};
 const counted = running.filter(record => !record.journey);
 const limit = Number(env.RER_SERVER_LIMIT ?? pin.limit);
 const binding = pin.explicitOnly ? counted.filter(record => record.explicit) : counted;
 const cap = Math.min(limit, ...binding.map(record => record.limit));
 if (counted.length < cap) return {};
 const holders = cap < limit ? binding.filter(record => record.limit === cap) : [];
 if (holders.length) throw new LaunchFailure(4, [
  `Not started: ${holders.length === 1 ? 'a server' : 'servers'} started with a limit of ${cap} hold${holders.length === 1 ? 's' : ''} this checkout's rer copy to ${cap} running servers, and ${counted.length} ${counted.length === 1 ? 'is' : 'are'} running:`,
  ...holders.map(record => `  ${record.mode} for ${record.checkout} (PID ${record.owner?.pid})`),
  `Restart ${holders.length === 1 ? 'it' : 'each'} under rer, which records ${personDefaults.limit} servers:`,
  ...holders.flatMap(record => [`  rer ${record.mode} --stop --cwd ${JSON.stringify(record.checkout)}`, `  rer ${record.mode} --cwd ${JSON.stringify(record.checkout)}`]),
  'rer never stops another checkout\'s server itself.',
 ].join('\n'));
 throw new LaunchFailure(4, [
  `Not started: ${counted.length} dev or preview ${counted.length === 1 ? 'server is' : 'servers are'} running on this computer and the limit is ${cap}.`,
  'Running now:', ...counted.map(listing),
  `To make room, stop one with its command above, or start this one with a higher limit, for example RER_SERVER_LIMIT=${cap * 2} rer dev.`,
 ].join('\n'));
}
