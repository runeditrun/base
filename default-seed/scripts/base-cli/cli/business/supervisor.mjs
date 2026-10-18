import { randomUUID } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, taskPath, pause } from './api.mjs';
import { paired, revokedByServer, revokedText } from './local-commands.mjs';
import { nextQuestions, ownerLink, waitingFor } from './questions.mjs';
import { lockSupervisor, stateDirectory, saveState } from './state.mjs';
import { loadProgress, saveProgress } from './progress.mjs';
import { Lease } from './lease.mjs';
import { runDiscovery } from './discovery-task.mjs';
import { applyChoices } from './choices.mjs';
import { businessCommand } from './invocation.mjs';

const kinds = new Set(['discover.local', 'export.vendor']);
const unavailableReasons = new Set(['ambiguous-target-installation', 'no-linked-installation', 'installation-import-origin-unavailable', 'installation-owner-claim-unconfigured', 'connected-seed-import-required']);
const checkIn = 25_000;

/** Work this computer's tasks. It says what it is doing and what it waits
 * for, applies the owner's choices at every check-in, and removes run.lock on
 * every exit, including Ctrl-C, SIGTERM and a closed terminal (SIGHUP). */
export async function run({ once = false } = {}) {
 const { state, credential } = await paired(), api = new Api(state.origin, credential), directory = stateDirectory();
 const parked = new Set(), unlock = await lockSupervisor(), stop = new AbortController();
 const interrupted = signal => () => { unlock.now(); stop.abort(Object.assign(Error('Business supervisor stopped.'), { signal })); };
 const handlers = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => [signal, interrupted(signal)]));
 for (const [signal, handler] of Object.entries(handlers)) process.once(signal, handler);
 const monitor = setInterval(() => { access(join(directory, 'disconnect')).then(() => stop.abort(Error('Business supervisor stopped for disconnect.')), () => {}); }, 250);
 let progress, said = '', held = null;
 const say = text => { if (text !== said) { said = text; process.stdout.write(text + '\n'); } };
 try {
  progress = await loadProgress();
  await unlink(join(directory, 'disconnect')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!once) process.stdout.write(`Business run is working this computer's tasks for ${ownerLink(state)}. It checks in every ${checkIn / 1000} seconds and keeps going until you stop it (Ctrl-C).\n`);
  do {
   const { serviceInstalled } = await applyChoices(api, state);
   if (serviceInstalled && !once) {
    process.stdout.write('The background service now works this computer\'s tasks, so this run stops here.\n');
    return;
   }
   if (!progress.pendingClaim) {
    const summaries = await nextQuestions(api, stop.signal);
    const selected = summaries.find(task => kinds.has(task.kind) && ['ready','leased'].includes(task.state) && !parked.has(task.task_id));
    if (!selected) {
     say(waitingFor(state));
     if (once) { process.stdout.write('Nothing yet.\n'); return; }
     await pause(checkIn, stop.signal); continue;
    }
    held = selected.state === 'leased' ? selected.task_id : null;
    progress.pendingClaim = { claim_id: randomUUID(), task_id: selected.task_id };
    await saveProgress(progress);
   }
   let claimed;
   try { claimed = await api.post('/api/business/executors/claim', { ...progress.pendingClaim, wait_seconds: 25 }, { signal: stop.signal }); }
   catch (error) {
    if (error.status !== 409) throw error;
    progress = {}; await saveProgress(progress);
    if (once) throw error;
    await pause(checkIn, stop.signal); continue;
   }
   if (!claimed.task || claimed.task.state !== 'leased' || claimed.task.fence !== claimed.fence || Date.parse(claimed.lease_expires_at) <= Date.now()) {
    const interrupted = held === progress.pendingClaim?.task_id;
    progress = {}; await saveProgress(progress);
    // A task this computer held before it was stopped stays leased until the
    // lease ends; then the server returns it to ready with its checkpoint.
    if (!claimed.task && interrupted) say('Waiting for the server to hand back the scan this computer was doing when it stopped; its earlier lease has not ended yet.');
    if (once && !claimed.task) { if (!interrupted) say(waitingFor(state)); process.stdout.write('Nothing yet.\n'); return; }
    continue;
   }
   if (!kinds.has(claimed.task.kind) || claimed.task.kind_version !== 1) throw Error('Business server returned an unimplemented task kind.');
   const lease = new Lease(api, claimed, progress, stop.signal);
   let finished = false, released = false, failure;
   try {
    progress.current = { kind: claimed.task.kind, checkpoint: claimed.task.checkpoint, uploadedBytes: claimed.task.checkpoint?.bytes_done ?? 0 };
    await saveProgress(progress);
    if (claimed.task.kind === 'export.vendor') {
     // A destination is not upload authority. Keep vendor keys local until
     // the seed's signed import grant and chunk transport are connected.
     await lease.send(taskPath(claimed.task.id, 'events'), { event: { kind: 'question', payload: { question: 'connected_runner_required' } } });
     parked.add(claimed.task.id);
     if (claimed.grant.available === false && claimed.grant.destination === `unavailable:${claimed.grant.reason}`) {
      const reason = unavailableReasons.has(claimed.grant.reason) ? claimed.grant.reason : 'connected-seed-import-required';
      throw Error(`Business vendor export unavailable: ${reason}. Task released as paused.`);
     }
     throw Error('Business vendor export needs a connected seed upload grant and execution-input contract.');
    }
    const page = claimed.task.checkpoint?.page;
    say(page ? `Resuming the names-only scan of this computer's allowed folders from page ${page + 1}.` : 'Scanning this computer\'s allowed folders for tool names (names only; no file contents leave this computer).');
    const result = await runDiscovery({ task: claimed.task, grant: claimed.grant, checkpoint: claimed.task.checkpoint, signal: lease.signal,
     send: (destination, body) => lease.send(destination, body), stateDir: directory,
     saveCheckpoint: async checkpoint => {
      await lease.checkpointSaved(checkpoint);
      if (checkpoint.page) process.stdout.write(`Sent page ${checkpoint.page} of ${checkpoint.total}; the server has ${checkpoint.records_done} names and saved this checkpoint.\n`);
     } });
    await lease.complete(); finished = true;
    await result.cleanup();
    if (!state.discovered) { state.discovered = true; await saveState(state); }
    say('Business discover.local completed and checked by the server.');
   } catch (error) { failure = lease.signal.aborted ? lease.signal.reason : error; }
   finally {
    if (!finished && failure?.status !== 401) {
     try { await lease.release(stop.signal.aborted ? 'handover' : parked.has(claimed.task.id) ? 'paused' : 'failed'); released = true; }
     catch (error) { if (error.status === 401) failure = error; }
    }
    await lease.close();
    if (finished || released) { progress = {}; await saveProgress(progress); }
   }
   if (failure) {
    if (failure.status === 401 || once || !parked.has(claimed.task.id)) throw failure;
    process.stderr.write(failure.message + '\n');
   }
   if (once) return;
  } while (!stop.signal.aborted);
 } catch (error) {
  if (error.status === 401) {
   const revoked = await revokedByServer(state);
   process.stderr.write(`Business pairing expired or was revoked, so this supervisor stopped. This computer was ${revokedText(revoked)}\n`);
  } else if (!stop.signal.aborted) throw error;
 } finally {
  clearInterval(monitor);
  for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  await unlock();
 }
 if (stop.signal.reason?.signal) process.stdout.write(`Business supervisor stopped (${stop.signal.reason.signal}); run.lock removed. Run ${businessCommand('run')} again to continue from the saved checkpoint.\n`);
}
