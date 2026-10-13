// The door's policy is stored, never inherited: `rer door enable` records the
// limit, the idle time and the RER_* variables in effect at that moment, and
// every site the door starts gets exactly those on top of an allowlisted base
// environment. Whoever later starts the door (a fleet agent, a test) cannot
// change them by running it with another environment.
import { resolve } from 'node:path';
import { doorDefaults, doorDirectory } from '../../cli/door.mjs';
import { serversDirectory } from '../registry.mjs';

const base = new Set(['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM']);
// Set by the policy itself, so never recorded from a shell.
const policyVariables = new Set(['RER_SERVER_LIMIT', 'RER_SERVER_IDLE_SECONDS']);

export function baseEnvironment(env = process.env) {
 return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && (base.has(name) || name.startsWith('LC_'))));
}

export function recordedEnvironment(env = process.env) {
 return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && name.startsWith('RER_') && !policyVariables.has(name)).sort(([a], [b]) => a.localeCompare(b)));
}

function count(value, name, minimum = 1) {
 if (!/^[0-9]+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw Object.assign(Error(`${name} takes a whole number of at least ${minimum}.`), { exitCode: 2 });
 return Number(value);
}

// What `rer door enable` records: flags, else the person defaults.
export function enabledPolicy({ port, serverLimit, idleTimeout }, env = process.env) {
 const chosen = port === undefined ? undefined : count(port, '--port');
 if (chosen !== undefined && chosen > 65535) throw Object.assign(Error('--port takes a port from 1 to 65535.'), { exitCode: 2 });
 return {
  port: chosen,
  policy: { serverLimit: serverLimit === undefined ? doorDefaults.serverLimit : count(serverLimit, '--server-limit'), idleSeconds: idleTimeout === undefined ? doorDefaults.idleSeconds : count(idleTimeout, '--idle-timeout') },
  directory: doorDirectory(env),
  serversDir: resolve(serversDirectory(env)),
  environment: recordedEnvironment(env),
 };
}

// The environment of a site the door starts.
export function siteEnvironment(door, env = process.env) {
 return { ...baseEnvironment(env), ...door.environment, RER_DOOR_DIR: door.directory, RER_SERVERS_DIR: door.serversDir, RER_SERVER_LIMIT: String(door.policy.serverLimit), RER_SERVER_IDLE_SECONDS: String(door.policy.idleSeconds) };
}

// The environment of the door process itself.
export const doorProcessEnvironment = (door, env = process.env) => ({ ...baseEnvironment(env), RER_DOOR_DIR: door.directory });

// `rer dev` may bring an enabled door back only for the registry it records.
export const ownsRegistry = (door, env = process.env) => doorDirectory(env) === door.directory && resolve(serversDirectory(env)) === door.serversDir;
