import { randomUUID } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, taskPath, pause } from './api.mjs';
import { createCredentialStore } from './keychain.mjs';
import { paired } from './local-commands.mjs';
import { nextQuestions } from './questions.mjs';
import { lockSupervisor, stateDirectory, credentialHandle } from './state.mjs';

const kinds = new Set(['discover.local', 'export.vendor']);

/** A deterministic runner must not infer private execution inputs from the
 * agent-facing task summary. Until the protocol supplies a scoped execution
 * document, return the lease with its checkpoint and a typed configuration
 * question, before accessing local files or a vendor key.
 */
export async function run({ once = false } = {}) {
 const { state, credential } = await paired(), api = new Api(state.origin, credential), directory = stateDirectory();
 const parked = new Set();
 const unlock = await lockSupervisor(), stop = new AbortController();
 const interrupted = () => stop.abort(new Error('Business supervisor stopped.'));
 process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
 const monitor = setInterval(() => { access(join(directory, 'disconnect')).then(interrupted, () => {}); }, 250);
 try {
  await unlink(join(directory, 'disconnect')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  do {
   const summaries = await nextQuestions(api, stop.signal);
   const selected = summaries.find(task => kinds.has(task.kind) && task.state === 'ready' && !parked.has(task.task_id));
   if (!selected) { if (once) { process.stdout.write('Nothing yet.\n'); return; } await pause(25_000, stop.signal); continue; }
   const claimed = await api.post('/api/business/executors/claim', { claim_id: randomUUID(), task_id: selected.task_id, wait_seconds: 25 }, { signal: stop.signal });
   if (!claimed.task) { if (once) return; continue; }
   const minted = await api.post('/api/business/executors/token', { audience: 'tasks', task_id: claimed.task.id }, { signal: stop.signal });
   const options = { token: minted.access_token, signal: stop.signal };
   const envelope = { fence: claimed.fence, grant_id: claimed.grant.id };
   try {
    await api.post(taskPath(claimed.task.id, 'events'), { ...envelope, client_event_id: randomUUID(), event: { kind: 'question', payload: { question: 'configuration_required' } } }, options);
   } finally {
    await api.post(taskPath(claimed.task.id, 'release'), { ...envelope, client_event_id: randomUUID(), reason: 'paused', checkpoint: claimed.task.checkpoint ?? {} }, { token: minted.access_token });
   }
   const message = 'Business executor protocol is missing the consented execution inputs and export upload contract. Task released without reading local files or vendor keys.';
   if (once) throw Error(message);
   process.stderr.write(message + '\n');
   parked.add(claimed.task.id);
  } while (!stop.signal.aborted);
 } catch (error) {
  if (error.status === 401) {
   await createCredentialStore().delete(credentialHandle(state.origin));
   process.stderr.write('Business pairing expired or was revoked. Supervisor stopped.\n');
  } else if (!stop.signal.aborted) throw error;
 }
 finally {
  clearInterval(monitor); process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted); await unlock();
 }
}
