// What a launch needs to know about a checkout before it changes anything.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { probePort, searchPort } from '../../onboarding/port-probe.mjs';
import { LaunchFailure } from './failure.mjs';

const run = promisify(execFile);
async function mtime(path) { try { return (await stat(path)).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }

// The pinned dispatcher's own read-only description.
export async function describeCheckout(root, entry, env, signal) {
 try {
  const { stdout } = await run(process.execPath, [entry, 'describe', '--json'], { cwd: root, env, maxBuffer: 16 * 1024 * 1024, signal });
  return JSON.parse(stdout);
 } catch (error) {
  if (signal?.aborted) throw signal.reason;
  throw new LaunchFailure(error.code ?? 1, (error.stderr?.trim() || `rer describe failed in ${root}.`));
 }
}

// Install when the last install was killed, nothing is linked, or the lockfile
// changed since. pnpm writes node_modules/.modules.yaml only once dependencies
// are linked and built, so a stopped install leaves it absent. An install this
// launcher ran is finished only when its record says so: that also covers the
// project's own install hooks, which pnpm runs after writing the manifest. A
// recorded failed install is retried only when the lockfile or package.json is
// newer than both that attempt and what is installed; dependencies repaired
// since are current, and the next launch uses them.
export async function needsInstall(root, last) {
 if (last?.state === 'running') return true;
 const linked = await mtime(join(root, 'node_modules/.modules.yaml'));
 if (linked === undefined) return true;
 const since = Math.max(linked, last?.at ?? 0);
 for (const file of last?.state === 'failed' ? ['pnpm-lock.yaml', 'package.json'] : ['pnpm-lock.yaml']) {
  const changed = await mtime(join(root, file));
  if (changed !== undefined && changed > since) return true;
 }
 return false;
}

export { hasSettings, setupNeeded } from '../../cli/checkout-preparation.mjs';

// Only a positive listener observation justifies saying another process took it.
export async function portTaken(port) {
 return Boolean((await probePort('127.0.0.1', port, { hosts: ['127.0.0.1', '::1'], anyAddress: true })).listener);
}

// The first port from 8787 (RER_DEV_PORT_FROM moves the start), among the next
// `searchCandidates` ports, that is not `held` by a live server or launch
// owner, nothing listens on, binds on both
// 127.0.0.1 and ::1 (a browser that tries ::1 first never reaches another
// server) and that `claim` secures against another launch choosing it at the
// same time. The search is bounded by that count, never by time or load.
export async function freePort(ports, claim, env = process.env) {
 const from = Number(env.RER_DEV_PORT_FROM ?? 8787);
 if (!Number.isInteger(from) || from < 1 || from > 65535) throw new LaunchFailure(2, 'RER_DEV_PORT_FROM must be a port number.');
 const held = new Set(ports.filter(Boolean));
 const found = await searchPort({ host: '127.0.0.1', from, hosts: ['127.0.0.1', '::1'], skip: port => held.has(port), claim, verb: 'dev' });
 if (found.port !== undefined) return found;
 throw new LaunchFailure(4, `No free port from ${found.range[0]} to ${found.range[1]}: all ${found.tried} ports tried were in use. Stop something that holds one, or pass rer dev --port PORT with a free port.`);
}
