// The detached launch worker: node worker.mjs ROOT TOKEN ARGS_JSON REQUESTED_AT
// (REQUESTED_AT: when the `rer dev` that spawned it started, epoch ms).
// It runs in its own session, so killing the `rer dev` that started it (or that
// command's whole process group) leaves it running; a rerun attaches to it.
// rer dev --stop ends it: SIGTERM, or, for a stop that ran before this worker
// claimed the launch, the stop request it reads right after claiming. Either
// way no further step starts, the running one is signalled, and the launch
// reports that it was stopped instead of ready.
import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { processInfo } from '../../modules/job-queue/processes.mjs';
import { liveServers } from '../registry.mjs';
import { LaunchFailure, workerFailure } from './failure.mjs';
import { prepare } from './prepare.mjs';
import { claimLaunch, eventLog, launchDirectory, liveWorker, releaseLaunch, serverRecord, stopRequest } from './state.mjs';
import { startServer } from './steps.mjs';

const [root, token, argsJSON, requestedAtText, mode] = process.argv.slice(2), args = JSON.parse(argsJSON), requestedAt = Number(requestedAtText), doorStart = mode === 'door-start';
const checkout = await realpath(root), directory = await launchDirectory(checkout), events = eventLog(directory, token);
// Listening before the claim: a stop may signal this worker as soon as it is the holder.
const children = new Set(), stopping = new AbortController();
const stop = () => { stopping.abort(); for (const child of children) child.kill('SIGTERM'); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
process.on('SIGHUP', () => {});
if (!await claimLaunch(directory, token)) {
 const holder = await liveWorker(directory);
 await events.write({ event: 'redirect', token: holder?.token });
} else {
 const logFile = createWriteStream(join(directory, 'launch.log'), { flags: 'a', mode: 0o600 });
 const log = text => logFile.write(text + '\n');
 try {
  if (await stopRequest.covers(directory, requestedAt)) stop();
  stopping.signal.throwIfAborted();
  const prepared = await prepare({ root, args, env: process.env, report: fields => events.write({ event: 'phase', ...fields }), directory, log, children, signal: stopping.signal, doorStart });
  await events.write({ event: 'phase', phase: 'start', message: prepared.own ? 'the app is already running; checking it' : 'starting the app' });
  // A server rer started logs to server.log; asking a running one for its
  // ready lines goes to reuse.log, and names server.log only when rer started it.
  const serverLog = join(directory, 'server.log');
  let started;
  try { started = await startServer(prepared.entry, args, { root, env: { ...process.env, ...prepared.added }, logPath: prepared.own ? join(directory, 'reuse.log') : serverLog, children, signal: stopping.signal, note: message => events.write({ event: 'phase', phase: 'note', message }) }); }
  finally { await prepared.release?.(); }
  const record = (await liveServers(process.env)).find(item => item.checkout === checkout);
  const pid = record?.owner?.pid ?? started.pid;
  // The server's PID, and the process rer spawned for it (the same one unless
  // the pin re-runs itself under its own Node), each with its start time.
  const identity = async id => ({ pid: id, start: (await processInfo(id))?.start });
  if (!prepared.own) await serverRecord.write(directory, { ...await identity(pid), spawned: await identity(started.pid) });
  const ours = !prepared.own || (await serverRecord.read(directory))?.pid === pid;
  // A stop that arrived while the server came up finds it registered and
  // stops it; this launch reports the stop rather than a server about to end.
  stopping.signal.throwIfAborted();
  await events.write({ event: 'ready', ready: started.ready, pid, ...(ours ? { log: serverLog } : {}) });
 } catch (error) {
  log(String(error?.stack ?? error));
  const failure = workerFailure(stopping.signal.aborted ? new LaunchFailure(1, 'rer dev --stop stopped this launch before the app was ready.') : error, { root });
  await events.write({ event: 'failed', exitCode: failure.exitCode, message: failure.message, error: failure.event });
 } finally {
  await releaseLaunch(directory, token);
  logFile.end();
 }
}
