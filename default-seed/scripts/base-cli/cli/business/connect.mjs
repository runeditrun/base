import { homedir } from 'node:os';
import { join } from 'node:path';
import { Api, originUrl, identifier, pause } from './api.mjs';
import { loadState, saveState, credentialHandle, loadPending, savePending, clearPending } from './state.mjs';
import { createCredentialStore } from './keychain.mjs';
import { applyOptIns } from './opt-ins.mjs';

export const capabilities = ['discover.local', 'export.vendor:sentry', 'export.vendor:uptimerobot', 'export.vendor:pagerduty', 'export.vendor:calendly'];

export async function connect({ code, origin } = {}) {
 const stored = await loadState();
 let pending = await loadPending();
 origin = originUrl(origin ?? stored?.origin ?? pending?.origin);
 if (stored) {
  if (stored.origin !== origin) throw Error('Business is paired to another origin. Disconnect before pairing again.');
  const credential = await createCredentialStore().get(credentialHandle(origin));
  if (!credential) throw Error('Business device credential is missing. Disconnect and create a new browser pairing code.');
  await applyOptIns(new Api(origin, credential), stored);
  return;
 }
 if (pending && Date.parse(pending.expires_at) <= Date.now()) { await clearPending(); pending = null; }
 if (pending && (pending.origin !== origin || code && pending.code !== code)) throw Error('Business has a pending pairing. Resume it or disconnect before using another code or origin.');
 const api = new Api(origin);
 if (!pending) {
  if (!code) throw Error(`Business needs a browser pairing code. Open ${origin}/business, then run rer business connect --code CODE --origin ${origin}.`);
  const response = await api.post('/api/business/executors/pair', {
   code, os: process.platform === 'darwin' ? 'macos' : 'linux', agent_kind: process.env.CODEX_HOME ? 'codex' : process.env.CLAUDECODE ? 'claude' : 'other', capabilities,
  });
  const expires = Math.min(Date.now() + 600_000, Date.parse(response?.expires_at));
  if (response?.status !== 'pending_approval' || !/^\d{6}$/.test(response.confirmation_number) || typeof response.pairing_token !== 'string' || !response.pairing_token || !Number.isFinite(expires) || expires <= Date.now()) throw Error('Business server returned an invalid pairing response.');
  pending = { origin, code, pairing_token: response.pairing_token, confirmation_number: response.confirmation_number, expires_at: new Date(expires).toISOString() };
  await savePending(pending);
 }
 process.stdout.write(`Confirmation number: ${pending.confirmation_number}\nCompare this number in the browser that created the code, then approve.\n`);
 while (Date.now() < Date.parse(pending.expires_at)) {
  let result;
  try { result = await api.post('/api/business/executors/pair', { pairing_token: pending.pairing_token }); }
  catch (error) {
   if ([401, 403, 410].includes(error.status)) { await clearPending(); throw Error('Business browser pairing was refused or expired. Create a new code in the browser.'); }
   throw error;
  }
  if (result?.status === 'paired') {
   if (typeof result.device_credential !== 'string') throw Error('Business server returned an invalid device credential.');
   const state = { version: 1, origin, businessId: identifier(result.business_id), executorId: identifier(result.executor_id), vendorHandles: [], awakeConsent: false };
   const store = createCredentialStore(), handle = credentialHandle(origin);
   // No authenticated request (including activation) before both durable writes.
   await store.set(handle, result.device_credential);
   try { await saveState(state); } catch (error) { await store.delete(handle); throw error; }
   await clearPending();
   process.stdout.write('Business paired. Device credential stored in OS keychain.\n');
   await applyOptIns(new Api(origin, result.device_credential), state);
   return;
  }
  if (['denied', 'refused', 'expired'].includes(result?.status)) {
   await clearPending(); throw Error('Business browser pairing was refused or expired. Create a new code in the browser.');
  }
  if (result?.status !== 'authorization_pending') throw Error('Business server returned an invalid pairing status.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
   process.stdout.write(`Waiting for the owner in ${origin}/business. After approval, run rer business connect --origin ${origin} again to resume this pairing.\n`);
   return;
  }
  await pause(Math.max(1, Math.min(5, Number(result.interval) || 5)) * 1000);
 }
 await clearPending();
 throw Error('Business browser pairing expired. Create a new code in the browser.');
}

export function localRoot(path) {
 if (typeof path !== 'string' || !path || path.includes('\0')) throw Error('Task has an invalid consented scan root.');
 return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
