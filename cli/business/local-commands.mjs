import { readFile, writeFile, unlink, rm, rmdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadState, saveState, stateDirectory, credentialHandle } from './state.mjs';
import { createCredentialStore, readSecret } from './keychain.mjs';
import { removeService, serviceStatus } from './service.mjs';
import { removePermissions } from './permissions.mjs';
import { pause } from './api.mjs';
import { loadProgress } from './progress.mjs';
import { VENDORS } from './vendors/index.mjs';

export async function paired() {
 const state = await loadState();
 if (!state?.origin || !state.businessId || !state.executorId) throw Error('This computer is not paired. Run rer business connect --code CODE.');
 const credential = await createCredentialStore().get(credentialHandle(state.origin));
 if (!credential) throw Error('Business device credential is missing. Reconnect in your browser.');
 return { state, credential };
}

export async function vendorKey(action, vendor) {
 if (!['add', 'remove'].includes(action) || !VENDORS.includes(vendor)) throw Error('Choose add or remove and a shipped vendor: sentry, uptimerobot, pagerduty, calendly.');
 const { state } = await paired(), store = createCredentialStore(), handle = `vendor:${vendor}:read`;
 if (action === 'add') {
  let secret = await readSecret();
  try { await store.set(handle, secret); } finally { secret = undefined; }
  state.vendorHandles = [...new Set([...(state.vendorHandles ?? []), handle])];
 } else {
  await store.delete(handle);
  state.vendorHandles = (state.vendorHandles ?? []).filter(item => item !== handle);
 }
 await saveState(state);
 process.stdout.write(`${vendor}:read ${action === 'add' ? 'stored in OS keychain' : 'removed'}.\n`);
}

async function stopSupervisor(directory) {
 const lock = join(directory, 'run.lock');
 try { await lstat(lock); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
 await writeFile(join(directory, 'disconnect'), '', { mode: 0o600 });
 for (let attempt = 0; attempt < 100; attempt++) {
  try {
   const pid = Number(await readFile(lock, 'utf8'));
   if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; await unlink(lock); return; }
   }
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await pause(100);
 }
 throw Error('Business supervisor is still stopping. Retry disconnect shortly.');
}

export async function disconnect() {
 const state = await loadState(), directory = stateDirectory();
 await removeService();
 await stopSupervisor(directory);
 await removePermissions();
 if (state) {
  const store = createCredentialStore();
  for (const handle of state.vendorHandles ?? []) await store.delete(handle);
  if (state.origin) await store.delete(credentialHandle(state.origin));
 }
 await rm(directory, { recursive: true, force: true });
 // Remove only an empty parent; other rer commands may own it.
 await rmdir(dirname(directory)).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
 process.stdout.write('Business disconnected. Local service, credentials and added permissions removed.\n');
}

export async function status({ json = false } = {}) {
 const state = await loadState();
 if (!state) {
  process.stdout.write(json ? JSON.stringify({ paired: false, service: 'not_installed', current_task: null, checkpoint: null, questions_cli: 'none' }) + '\n' : 'Business: not paired.\nService: not installed.\nTask: none.\nCheckpoint: none.\nQuestions CLI: none.\n'); return;
 }
 const stored = state.origin && await createCredentialStore().get(credentialHandle(state.origin));
 const service = await serviceStatus();
 const active = (await loadProgress()).current;
 if (json) {
  process.stdout.write(JSON.stringify({ paired: Boolean(stored), questions_cli: state.classifier?.name ?? 'none', service: service.running ? 'running' : service.installed ? 'stopped' : 'not_installed', current_task: ['discover.local', 'export.vendor', 'classify.row'].includes(active?.kind) ? active.kind : null, checkpoint: active?.checkpoint ? { saved: true, uploaded_bytes: Number.isSafeInteger(active.uploadedBytes) ? active.uploadedBytes : 0 } : null }) + '\n');
  return;
 }
 process.stdout.write(`Business: ${stored ? 'paired' : 'credential missing'}.\nService: ${service.running ? 'running' : service.installed ? 'installed, stopped' : 'not installed'}.\n`);
 process.stdout.write(`Questions CLI: ${state.classifier?.name ?? 'none'}.\n`);
 process.stdout.write(`Task: ${['discover.local', 'export.vendor', 'classify.row'].includes(active?.kind) ? active.kind : 'none'}.\n`);
 process.stdout.write(`Checkpoint: ${active?.checkpoint ? 'saved' : 'none'}${Number.isSafeInteger(active?.uploadedBytes) ? `; ${active.uploadedBytes} bytes uploaded` : ''}.\n`);
}
