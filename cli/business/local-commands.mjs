import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState, loadPending, saveState, stateDirectory, removeStateDirectory, removeWorkFiles, credentialHandle, liveSupervisor } from './state.mjs';
import { createCredentialStore, readSecret } from './keychain.mjs';
import { removeService, serviceStatus } from './service.mjs';
import { removePermissions, permissionsAdded } from './permissions.mjs';
import { Api, pause } from './api.mjs';
import { loadProgress } from './progress.mjs';
import { KEYED_VENDORS } from './vendors/index.mjs';
import { vendorHandle } from './vendor-door.mjs';
import { rerCommand, businessCommand } from './invocation.mjs';
import { describe } from './errors.mjs';
import { supportsTaskKind } from './supervisor.mjs';

export async function paired() {
 const state = await loadState();
 if (!state?.origin || !state.businessId || !state.executorId) throw Error(`This computer is not paired. Run ${rerCommand()} business connect --code CODE.`);
 if (state.revoked) throw Error(`This computer was ${revokedText(state)}`);
 const credential = await createCredentialStore().get(credentialHandle(state.origin));
 if (!credential) throw Error(`This computer's Business credential is missing from OS credential storage. Run ${rerCommand()} business disconnect, then connect again with a new code from ${state.origin}/business.`);
 return { state, credential };
}

// What a revoked computer still keeps here, in the words a person reads.
const leftoverWords = { credential: 'the local credential is still stored', vendorKeys: 'vendor keys are still stored', service: 'the background service is still installed', permissions: 'the added Claude Code rules are still in place' };
export function revokedText(state, { cause = false } = {}) {
 const left = (state.revoked?.leftovers ?? []).filter(item => Object.hasOwn(leftoverWords, item));
 if (!left.length) return `revoked on the server. Finish with ${businessCommand('disconnect')}`;
 return `revoked on the server; ${left.map(item => leftoverWords[item]).join(', ')}.${cause && state.revoked.cause ? `\n${state.revoked.cause}` : ''}\nRemove ${left.length === 1 ? 'it' : 'them'} with this one command, run outside the agent sandbox or in your own terminal:\n  ${businessCommand('disconnect')}`;
}

/** After the server revoked this computer, remove what this session can and
 * keep a record of the rest, so status says revoked and a later disconnect
 * (outside an agent sandbox) finishes. Returns the leftovers. */
export async function forgetLocally(state, { stopRun = true } = {}) {
 const leftovers = [], store = state?.origin ? createCredentialStore() : null;
 const attempt = async (item, work) => { try { await work(); } catch (error) { leftovers.push(item); return error; } };
 const directory = stateDirectory();
 if (stopRun) await stopSupervisor(directory);
 await attempt('service', () => removeService());
 await attempt('permissions', () => removePermissions());
 const vendorKeys = [];
 for (const handle of store ? state.vendorHandles ?? [] : []) if (await attempt('vendorKeys', () => store.delete(handle))) vendorKeys.push(handle);
 const refused = store ? await attempt('credential', () => store.delete(credentialHandle(state.origin))) : undefined;
 if (!leftovers.length) { await removeStateDirectory(); return []; }
 const unique = [...new Set(leftovers)];
 const cause = refused && (refused.sandboxRefused ? `macOS Keychain refused to remove it inside this agent sandbox (security exited with status ${refused.osStatus ?? 'unknown'}).` : describe(refused));
 await saveState({ ...state, vendorHandles: vendorKeys, revoked: { at: new Date().toISOString(), leftovers: unique, ...(cause ? { cause } : {}) } });
 await removeWorkFiles();
 return unique;
}

/** The server answered 401 to this computer's own credential: it was revoked
 * (or expired). Remove the credential if this session may, and record what
 * is left so status says revoked and disconnect finishes the rest. */
export async function revokedByServer(state) {
 const leftovers = [];
 let cause;
 try { await createCredentialStore().delete(credentialHandle(state.origin)); }
 catch (error) { leftovers.push('credential'); cause = error.sandboxRefused ? `macOS Keychain refused to remove it inside this agent sandbox (security exited with status ${error.osStatus ?? 'unknown'}).` : describe(error); }
 if (state.vendorHandles?.length) leftovers.push('vendorKeys');
 if ((await serviceStatus()).installed) leftovers.push('service');
 if (await permissionsAdded()) leftovers.push('permissions');
 const saved = { ...state, revoked: { at: new Date().toISOString(), leftovers, ...(cause ? { cause } : {}) } };
 await saveState(saved);
 await removeWorkFiles(['state.json', 'permissions.json', 'service.json', 'run.lock']);
 return saved;
}

export async function vendorKey(action, vendor) {
 if (!['add', 'remove'].includes(action) || !KEYED_VENDORS.includes(vendor)) throw Error(`Choose add or remove and a shipped vendor that reads with a key: ${KEYED_VENDORS.join(', ')}. Sorry needs no key.`);
 const { state } = await paired(), store = createCredentialStore(), handle = vendorHandle(vendor);
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
 if (!await liveSupervisor(lock)) return;
 await writeFile(join(directory, 'disconnect'), '', { mode: 0o600 });
 for (let attempt = 0; attempt < 100; attempt++) {
  if (!await liveSupervisor(lock)) { await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
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

/** Revoke on the server first, then remove the local service, rules, keys and
 * credential. When this session may not remove something (macOS refuses
 * Keychain changes inside an agent sandbox), the computer is still revoked:
 * say so, keep a record so status says revoked, name the one command that
 * finishes outside the sandbox, and exit 0. */
export async function disconnect() {
 const state = await loadState();
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
 const wasRevoked = Boolean(state?.revoked);
 const leftovers = await forgetLocally(state);
 if (leftovers.length) {
  const saved = await loadState();
  process.stdout.write(`R${revokedText(saved, { cause: true }).slice(1)}\nUntil then, status says revoked; this computer can no longer reach Business.\n`);
  return;
 }
 process.stdout.write(revocation === 'revoked'
  ? `Business disconnected. Device ${wasRevoked ? 'was already revoked' : 'revoked'}; local service, credentials and added permissions removed.\n`
  : wasRevoked ? 'Business disconnected. Device was already revoked on the server; local service, credentials and added permissions removed.\n'
  : `Business disconnected on this computer: local service, credentials and added permissions removed. Nothing was revoked: no device credential was stored here${page ? `. If this computer still shows in ${page}, revoke it there` : ''}.\n`);
}

export async function status({ json = false } = {}) {
 const state = await loadState();
 if (!state) {
  process.stdout.write(json ? JSON.stringify({ paired: false, service: 'not_installed', current_task: null, checkpoint: null }) + '\n' : 'Business: not paired.\nService: not installed.\nTask: none.\nCheckpoint: none.\n'); return;
 }
 const stored = !state.revoked && state.origin && await createCredentialStore().get(credentialHandle(state.origin));
 const service = await serviceStatus();
 const active = state.revoked ? null : (await loadProgress()).current;
 if (json) {
  process.stdout.write(JSON.stringify({ paired: Boolean(stored), ...(state.revoked ? { revoked: true } : {}), service: service.running ? 'running' : service.installed ? 'stopped' : 'not_installed', current_task: supportsTaskKind(active?.kind) ? active.kind : null, checkpoint: active?.checkpoint ? { saved: true, uploaded_bytes: Number.isSafeInteger(active.uploadedBytes) ? active.uploadedBytes : 0 } : null }) + '\n');
  return;
 }
 process.stdout.write(`Business: ${state.revoked ? revokedText(state) : stored ? 'paired.' : 'credential missing.'}\nService: ${service.running ? 'running' : service.installed ? 'installed, stopped' : 'not installed'}.\n`);
 process.stdout.write(`Task: ${supportsTaskKind(active?.kind) ? active.kind : 'none'}.\n`);
 process.stdout.write(`Checkpoint: ${active?.checkpoint ? 'saved' : 'none'}${Number.isSafeInteger(active?.uploadedBytes) ? `; ${active.uploadedBytes} bytes uploaded` : ''}.\n`);
}
