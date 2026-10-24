// rer dev --stop for a checkout the launcher may be preparing or serving.
// It ends a launch still preparing (or one that has not yet claimed the
// checkout), has the pinned dispatcher stop the registered server, and then
// checks that every process it found -- the worker, the server rer started,
// the registered server and everything they spawned -- has exited. It says
// what it stopped, or exits non-zero naming what is still running.
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { processInfo } from '../../modules/job-queue/processes.mjs';
import { isExited, readProcessTable, sameBirth } from '../../onboarding/process-table.mjs';
import { delegate } from '../delegate.mjs';
import { liveServers } from '../registry.mjs';
import { serverStatus } from '../../cli/server-registry.mjs';
import { LaunchFailure } from './failure.mjs';
import { readWorker, serverRecord, stopRequest } from './state.mjs';

export async function stopLaunch(target, devArgs, { checkout, directory }) {
 // Written before looking for a worker: one that claims the launch after this
 // look reads it and ends itself (worker.mjs).
 await stopRequest.write(directory);
 const holder = await readWorker(directory);
 const verified = holder && await verifiedWorker(holder, checkout);
 const launch = verified ? await tree([holder]) : [];
 if (verified) await endWorker(holder, checkout);
 else if (holder) {
  await rm(join(directory, 'worker.json'), { force: true });
  process.stderr.write(`Dropped foreign or unverified launch worker entry for ${checkout}; no signal was sent.\n`);
 }
 // Only now: a worker stopped while its server came up has registered it.
 let record;
 for (const candidate of (await liveServers()).filter(item => item.checkout === checkout)) {
  try { await serverStatus(candidate); record = candidate; break; } catch {}
 }
 const started = await serverRecord.read(directory);
 const server = await tree([record?.owner, record?.runtimeProcess, started, started?.spawned]);
 await delegate(target, ['dev', ...devArgs]);
 if (process.exitCode) return process.exitCode;
 const left = await exited([...launch, ...server], 15000);
 if (left.length) {
  const pids = left.map(item => item.pid).join(' ');
  process.stderr.write(`rer dev --stop: ${left.length === 1 ? 'a process' : `${left.length} processes`} recorded for this checkout's dev server ${left.length === 1 ? 'is' : 'are'} still running 15 seconds after the stop (PID ${pids}). Preserve these processes and inspect their ownership before stopping them.\n`);
  return 1;
 }
 if (!devArgs.includes('--json')) process.stdout.write(said({ checkout, record, started, server, holder:verified?holder:undefined, launch }) + '\n');
 return 0;
}

// SIGTERM the preparing worker and wait for it to exit.
async function verifiedWorker(holder, checkout) {
 if (!Number.isSafeInteger(holder.pid) || holder.pid < 2 || typeof holder.token !== 'string') return false;
 const current = await processInfo(holder.pid);
 const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
 return Boolean(current && !current.zombie && current.start === holder.start
  && holder.checkout === checkout && current.title === holder.command
  && current.title.includes(`${worker} ${checkout} ${holder.token} `));
}

async function endWorker(holder, checkout) {
 if (!await verifiedWorker(holder, checkout)) return;
 try { process.kill(holder.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
 for (let waited = 0; waited < 60000; waited += 250) {
  const current = await processInfo(holder.pid);
  if (!current || current.zombie || current.start !== holder.start) return;
  await delay(250);
 }
 throw new LaunchFailure(1, `The launch worker (PID ${holder.pid}) did not stop within a minute.`);
}

// The live processes among these recorded identities ({pid, start}), with
// every process descended from them, as process-table entries.
async function tree(identities) {
 const roots = new Set();
 for (const identity of identities) {
  if (!identity?.pid || !identity.start) continue;
  const current = await processInfo(identity.pid);
  if (current && !current.zombie && current.start === identity.start) roots.add(identity.pid);
 }
 if (!roots.size) return [];
 const table = await readProcessTable(), found = table.filter(entry => roots.has(entry.pid));
 for (let index = 0; index < found.length; index++) {
  for (const entry of table) if (entry.ppid === found[index].pid && !found.includes(entry)) found.push(entry);
 }
 return found;
}

// Wait until none of these processes is running; return those still running.
async function exited(processes, within) {
 const deadline = Date.now() + within;
 for (;;) {
  const table = processes.length ? await readProcessTable() : [];
  const left = processes.filter(item => table.some(entry => sameBirth(item, entry) && !isExited(entry)));
  if (!left.length || Date.now() >= deadline) return left;
  await delay(250);
 }
}

function said({ checkout, record, started, server, holder, launch }) {
 const lines = [], more = n => n > 0 ? ` with ${n} more ${n === 1 ? 'process' : 'processes'}` : '';
 if (server.length) {
  const pid = record?.owner?.pid ?? started?.pid ?? server[0].pid;
  lines.push(`Stopped the dev server${record?.url ? ` at ${record.url}` : ''} for ${checkout} (PID ${pid})${more(server.length - 1)}.`);
 }
 if (holder) {
  const own = launch.filter(item => !server.some(entry => sameBirth(item, entry)));
  lines.push(`Stopped the launch still running for ${checkout} (PID ${holder.pid})${more(own.length - 1)}.`);
 }
 if (!lines.length) lines.push(`No dev server was running for ${checkout}.`);
 return lines.join('\n');
}
