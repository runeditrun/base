// Per-checkout launch state, private to the account, beside the server
// registry: <servers>/launches/<name>-<hash>/
//   worker.json   the preparing worker (PID, start time, token) while it runs
//   events-<token>.jsonl  what that worker has done, one JSON event per line
//   install.json  whether an install this launcher started has finished
//   setup.json    whether a setup this launcher started has finished
//   launch.log    the worker's private log (child output)
//   server.log    the private log of the server rer started
//   server.json   that server's PID and start time, and the process rer spawned
//   stop.json     when rer dev --stop last ran: a launch requested before it stops
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { processInfo } from '../../modules/job-queue/processes.mjs';
import { serversDirectory } from '../registry.mjs';

export function launchPath(checkout, env = process.env) {
 const name = basename(checkout).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'checkout';
 return join(serversDirectory(env), 'launches', `${name}-${createHash('sha256').update(checkout).digest('hex').slice(0, 12)}`);
}

export async function launchDirectory(checkout, env = process.env) {
 const directory = launchPath(checkout, env);
 await mkdir(directory, { recursive: true, mode: 0o700 });
 return directory;
}

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; } }

async function live(holder) {
 if (!holder?.pid) return false;
 const current = await processInfo(holder.pid);
 return Boolean(current && !current.zombie && current.start === holder.start);
}

export async function liveWorker(directory) {
 const holder = await readJson(join(directory, 'worker.json'));
 return await live(holder) ? holder : undefined;
}

// A port chosen for a setup stays claimed while the process that chose it
// lives, so two launches preparing at once never pick the same port.
export async function claimPort(port, env = process.env) {
 const directory = join(serversDirectory(env), 'launches', 'ports'), path = join(directory, `${port}.json`);
 await mkdir(directory, { recursive: true, mode: 0o700 });
 const { start } = await processInfo(process.pid);
 for (let attempt = 0; attempt < 2; attempt++) {
  try {
   await writeFile(path, JSON.stringify({ pid: process.pid, start }), { flag: 'wx', mode: 0o600 });
   return { release: async () => { if ((await readJson(path))?.pid === process.pid) await rm(path, { force: true }); } };
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await live(await readJson(path))) return undefined;
  await rm(path, { force: true });
 }
 return undefined;
}

// The worker claims the checkout's launch; a second worker started at the
// same moment finds the first and leaves.
export async function claimLaunch(directory, token) {
 const path = join(directory, 'worker.json');
 for (let attempt = 0; attempt < 3; attempt++) {
  const { start } = await processInfo(process.pid);
  try {
   await writeFile(path, JSON.stringify({ token, pid: process.pid, start, startedAt: Date.now(), events: `events-${token}.jsonl` }), { flag: 'wx', mode: 0o600 });
   for (const entry of await readdir(directory)) if (/^events-.*\.jsonl$/.test(entry) && entry !== `events-${token}.jsonl`) await rm(join(directory, entry), { force: true });
   return true;
  } catch (error) {
   if (error.code !== 'EEXIST') throw error;
   if (await liveWorker(directory)) return false;
   await rm(path, { force: true });
  }
 }
 return false;
}

export async function releaseLaunch(directory, token) {
 const holder = await readJson(join(directory, 'worker.json'));
 if (holder?.token === token) await rm(join(directory, 'worker.json'), { force: true });
}

export function eventLog(directory, token) {
 const path = join(directory, `events-${token}.jsonl`);
 return { path, write: event => appendFile(path, JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 }) };
}

// { state: 'running' | 'done' | 'failed', ... } for the last install or setup
// this launcher ran. 'running' survives only a step whose process was killed.
const stepRecord = name => ({
 read: directory => readJson(join(directory, `${name}.json`)),
 write: (directory, record) => writeFile(join(directory, `${name}.json`), JSON.stringify({ ...record, at: Date.now() }), { mode: 0o600 }),
});
export const installState = stepRecord('install'), setupState = stepRecord('setup');

// The ports other checkouts were set up on by this launcher. A stopped
// checkout keeps its saved origin, so a fresh launch must not take its port.
export async function savedPorts(checkout, env = process.env) {
 const launches = join(serversDirectory(env), 'launches'), own = launchPath(checkout, env);
 let entries = [];
 try { entries = await readdir(launches, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 const ports = [];
 for (const entry of entries) {
  if (!entry.isDirectory() || join(launches, entry.name) === own) continue;
  const port = (await setupState.read(join(launches, entry.name)))?.port;
  if (Number.isInteger(port)) ports.push(port);
 }
 return ports;
}

// A stop asks every launch started before it to end. A worker reads this right
// after it claims the launch; a stop that ran before the claim found no worker
// to signal, so the worker ends itself here instead of starting anything.
export const stopRequest = {
 write: directory => writeFile(join(directory, 'stop.json'), JSON.stringify({ at: Date.now(), pid: process.pid }), { mode: 0o600 }),
 covers: async (directory, requestedAt) => ((await readJson(join(directory, 'stop.json')))?.at ?? -Infinity) >= requestedAt,
};

export const serverRecord = {
 read: directory => readJson(join(directory, 'server.json')),
 write: (directory, record) => writeFile(join(directory, 'server.json'), JSON.stringify(record), { mode: 0o600 }),
};
