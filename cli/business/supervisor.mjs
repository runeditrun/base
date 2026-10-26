import { randomUUID } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, taskPath, pause } from './api.mjs';
import { paired } from './local-commands.mjs';
import { createCredentialStore } from './keychain.mjs';
import { nextQuestions } from './questions.mjs';
import { lockSupervisor, stateDirectory, credentialHandle } from './state.mjs';
import { loadProgress, saveProgress } from './progress.mjs';
import { Lease } from './lease.mjs';
import { runDiscovery } from './discovery-task.mjs';
import { applyOptIns } from './opt-ins.mjs';

const kinds = new Set(['discover.local', 'export.vendor']);
const unavailableReasons = new Set(['ambiguous-target-installation', 'no-linked-installation', 'installation-import-origin-unavailable', 'installation-owner-claim-unconfigured', 'connected-seed-import-required']);

export async function run({ once = false } = {}) {
 const { state, credential } = await paired(), api = new Api(state.origin, credential), directory = stateDirectory();
 const parked = new Set(), unlock = await lockSupervisor(), stop = new AbortController();
 const interrupted = () => stop.abort(Error('Business supervisor stopped.'));
 process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
 const monitor = setInterval(() => { access(join(directory, 'disconnect')).then(interrupted, () => {}); }, 250);
 let progress;
 try {
  await applyOptIns(api, state, { report: false });
  progress = await loadProgress();
  await unlink(join(directory, 'disconnect')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  do {
   if (!progress.pendingClaim) {
    const summaries = await nextQuestions(api, stop.signal);
    const selected = summaries.find(task => kinds.has(task.kind) && ['ready','leased'].includes(task.state) && !parked.has(task.task_id));
    if (!selected) { if (once) { process.stdout.write('Nothing yet.\n'); return; } await pause(25_000, stop.signal); continue; }
    progress.pendingClaim = { claim_id: randomUUID(), task_id: selected.task_id };
    await saveProgress(progress);
   }
   let claimed;
   try { claimed = await api.post('/api/business/executors/claim', { ...progress.pendingClaim, wait_seconds: 25 }, { signal: stop.signal }); }
   catch (error) {
    if (error.status !== 409) throw error;
    progress = {}; await saveProgress(progress);
    if (once) throw error;
    await pause(25_000, stop.signal); continue;
   }
   if (!claimed.task || claimed.task.state !== 'leased' || claimed.task.fence !== claimed.fence || Date.parse(claimed.lease_expires_at) <= Date.now()) {
    progress = {}; await saveProgress(progress);
    if (once && !claimed.task) { process.stdout.write('Nothing yet.\n'); return; }
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
    const result = await runDiscovery({ task: claimed.task, grant: claimed.grant, checkpoint: claimed.task.checkpoint, signal: lease.signal,
     send: (destination, body) => lease.send(destination, body), saveCheckpoint: checkpoint => lease.checkpointSaved(checkpoint), stateDir: directory });
    await lease.complete(); finished = true;
    await result.cleanup();
    process.stdout.write('Business discover.local completed and checked by the server.\n');
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
   await createCredentialStore().delete(credentialHandle(state.origin));
   process.stderr.write('Business pairing expired or was revoked. Supervisor stopped.\n');
  } else if (!stop.signal.aborted) throw error;
 } finally {
  clearInterval(monitor); process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted); await unlock();
 }
}
