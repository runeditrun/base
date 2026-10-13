// Start and stop the door process. It runs detached from the installed
// version's own files, with the allowlisted base environment and RER_DOOR_DIR
// only; its policy comes from the state `rer door enable` recorded.
import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processInfo } from '../../modules/job-queue/processes.mjs';
import { doorProtocol, prepareDoorDirectory, readDoorState, runningDoor, verifyDoor } from '../../cli/door.mjs';
import { doorProcessEnvironment } from './policy.mjs';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

export class DoorFailure extends Error { constructor(exitCode, message) { super(message); this.exitCode = exitCode; } }

export async function startDoor(env = process.env) {
 const state = await readDoorState(env);
 if (!state?.door?.enabled) throw new DoorFailure(3, 'The front door is not enabled on this computer. Enable it with: rer door enable');
 const running = await runningDoor(env);
 if (running) {
  if (running.protocol !== doorProtocol) throw new DoorFailure(4, `A front door speaking protocol ${running.protocol} is running (PID ${running.pid}); this rer speaks protocol ${doorProtocol}. Run rer door restart.`);
  return { door: running, already: true };
 }
 const door = state.door, directory = await prepareDoorDirectory(env), logPath = join(directory, 'logs', 'door.log');
 const log = await open(logPath, 'a', 0o600), from = (await log.stat()).size;
 let child, exited, failed;
 // Listening before anything is awaited: a spawn that fails reports it on the next tick.
 try {
  child = spawn(process.execPath, [serverPath], { cwd: directory, env: doorProcessEnvironment(door, env), detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.once('error', error => { failed = error; exited ??= 1; });
  child.once('exit', code => { exited = code ?? 1; });
 } finally { await log.close(); }
 for (let waited = 0; waited < 20000; waited += 100) {
  const record = await runningDoor(env);
  if (record && record.pid === child.pid) { child.unref(); await verifyDoor(env, record.port); return { door: record }; }
  if (exited !== undefined) {
   if (failed) throw new DoorFailure(1, `The front door could not be started: ${failed.code ?? failed.message}.`);
   // Another start (a rer dev bringing the door back) won the port: use that door.
   if (record?.protocol === doorProtocol) { await verifyDoor(env, record.port); return { door: record, already: true }; }
   const text = (await readFile(logPath, 'utf8')).slice(from).split('\n').filter(line => line.startsWith('rer door: ')).map(line => line.slice('rer door: '.length));
   throw new DoorFailure(exited === 4 ? 4 : 1, text.join('\n') || `The front door stopped while starting (exit ${exited}); see ${logPath}.`);
  }
  await delay(100);
 }
 child.kill('SIGTERM');
 throw new DoorFailure(1, `The front door did not start within 20 seconds; see ${logPath}.`);
}

// Stop the recorded door by its PID (after checking its start time) and wait
// until it has drained and exited, or with `released` (a restart) only until
// it has given up its port and process record, which it does before draining.
export async function stopDoor(env = process.env, { timeoutMs = 30000, released = false } = {}) {
 const running = await runningDoor(env);
 if (!running) return undefined;
 try { process.kill(running.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
 for (let waited = 0; waited < timeoutMs; waited += 100) {
  const current = await processInfo(running.pid);
  // The door removes its own process record as it drains; a stale one names a dead PID.
  if (!current || current.zombie || current.start !== running.start) return running;
  if (released && (await runningDoor(env))?.pid !== running.pid) return running;
  await delay(100);
 }
 throw new DoorFailure(1, `The front door (PID ${running.pid}) did not stop within ${timeoutMs / 1000} seconds.`);
}
