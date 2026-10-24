import { readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState, loadPending, saveState, stateDirectory, removeStateDirectory, credentialHandle } from './state.mjs';
import { createCredentialStore, readSecret } from './keychain.mjs';
import { removeService, serviceStatus } from './service.mjs';
import { removePermissions } from './permissions.mjs';
import { Api, pause } from './api.mjs';
import { loadProgress } from './progress.mjs';
import { VENDORS } from './vendors/index.mjs';
import { rerCommand } from './invocation.mjs';

export async function paired({ signal } = {}) {
 const state = await loadState();
 if (!state?.origin || !state.businessId || !state.executorId) throw Error(`This computer is not paired. Run ${rerCommand()} business connect --code CODE.`);
 const credential = await createCredentialStore().get(credentialHandle(state.origin), { signal });
 if (!credential) throw Error(`This computer's Business credential is missing from OS credential storage. Run ${rerCommand()} business disconnect, then connect again with a new code from ${state.origin}/business.`);
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

// 'revoked' once the server confirms, or answers 401 for a device it already
// revoked; 'unsupported' when it refuses device revocation (403 or 404, as a
// server without this route does); otherwise 'unconfirmed'.
async function revoke(origin, credential) {
 try { return (await new Api(origin, credential).delete('/api/business/executors/self'))?.revoked === true ? 'revoked' : 'unconfirmed'; }
 catch (error) { return error.status === 401 ? 'revoked' : [403, 404].includes(error.status) ? 'unsupported' : 'unconfirmed'; }
}

export async function disconnect() {
 const state = await loadState(), directory = stateDirectory();
 const origin = state?.origin ?? (await loadPending())?.origin;
 const page = origin && (state?.businessId ? `${origin}/business/${encodeURIComponent(state.businessId)}/settings` : `${origin}/business`);
 const credential = state?.origin ? await createCredentialStore().get(credentialHandle(state.origin)) : null;
 const revocation = credential ? await revoke(state.origin, credential) : 'not_sent';
 // Until the server confirms, the device stays connected: keep its credential
 // and everything else so disconnect can run again after browser revocation.
 if (revocation === 'unsupported') {
  process.stdout.write(`This computer is still connected to Business: the server would not revoke it from this computer. Revoke it in ${page}, then run ${rerCommand()} business disconnect again to remove its local service, credentials and added permissions.\n`);
  return;
 }
 if (revocation === 'unconfirmed') throw Error(`Business did not confirm revocation, so this computer is still connected and its credentials were kept. Retry ${rerCommand()} business disconnect, or revoke it in ${page} and then run disconnect again.`);
 await removeService();
 await stopSupervisor(directory);
 await removePermissions();
 if (state) {
  const store = createCredentialStore();
  for (const handle of state.vendorHandles ?? []) await store.delete(handle);
  if (state.origin) await store.delete(credentialHandle(state.origin));
 }
 await removeStateDirectory();
 process.stdout.write(revocation === 'revoked'
  ? 'Business disconnected. Device revoked; local service, credentials and added permissions removed.\n'
  : `Business disconnected on this computer: local service, credentials and added permissions removed. Nothing was revoked: no device credential was stored here${page ? `. If this computer still shows in ${page}, revoke it there` : ''}.\n`);
}

export async function status({ json = false } = {}) {
 const state = await loadState();
 if (!state) {
  process.stdout.write(json ? JSON.stringify({ paired: false, service: 'not_installed', current_task: null, checkpoint: null }) + '\n' : 'Business: not paired.\nService: not installed.\nTask: none.\nCheckpoint: none.\n'); return;
 }
 const stored = state.origin && await createCredentialStore().get(credentialHandle(state.origin));
 const service = await serviceStatus();
 const active = (await loadProgress()).current;
 if (json) {
  process.stdout.write(JSON.stringify({ paired: Boolean(stored), service: service.running ? 'running' : service.installed ? 'stopped' : 'not_installed', current_task: ['discover.local', 'export.vendor'].includes(active?.kind) ? active.kind : null, checkpoint: active?.checkpoint ? { saved: true, uploaded_bytes: Number.isSafeInteger(active.uploadedBytes) ? active.uploadedBytes : 0 } : null }) + '\n');
  return;
 }
 process.stdout.write(`Business: ${stored ? 'paired' : 'credential missing'}.\nService: ${service.running ? 'running' : service.installed ? 'installed, stopped' : 'not installed'}.\n`);
 process.stdout.write(`Task: ${['discover.local', 'export.vendor'].includes(active?.kind) ? active.kind : 'none'}.\n`);
 process.stdout.write(`Checkpoint: ${active?.checkpoint ? 'saved' : 'none'}${Number.isSafeInteger(active?.uploadedBytes) ? `; ${active.uploadedBytes} bytes uploaded` : ''}.\n`);
}
