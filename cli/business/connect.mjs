import { homedir } from 'node:os';
import { join } from 'node:path';
import { Api, originUrl, identifier, pause } from './api.mjs';
import { loadState, saveState, credentialHandle, deviceCredentialHandle, loadPending, savePending, clearPending, checkStateWritable, lockPairing } from './state.mjs';
import { createCredentialStore } from './keychain.mjs';
import { credentialLocation } from './credential-file.mjs';
import { applyChoices } from './choices.mjs';
import { rerCommand, businessCommand } from './invocation.mjs';
import { Stopped } from './errors.mjs';
import { agentKind, deviceName, workingFolder, operatingSystem } from './device.mjs';
import { revokedText } from './local-commands.mjs';

// Approval moves the server's pairing expiry to ten minutes after approval, and
// approval can come up to the code's own expiry. Keep the pending pairing until
// then and let the server decide whether it was approved in time.
const approvalWindow = 600_000;

export const capabilities = ['discover.local'];

const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** Pair (or resume a saved device pairing) and wait for the owner to approve. */
export async function connect(options = {}) {
 if (options.business !== undefined) return connectDevice(options);
 const pending = await loadPending();
 if (pending?.flow === 'device') return connectDevice(options);
 const stored = await loadState();
 if (stored) return connectDevice({ ...options, business: stored.businessId });
 const origin = originUrl(options.origin ?? pending?.origin);
 throw Error(`Set up your business: open ${origin}/business and take the prompt from the Business Connect page. It names the ID for ${rerCommand()} business connect --business ID.`);
}

const shortCode = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
const intervalValid = value => Number.isInteger(value) && value >= 1 && value <= 60;
const secretValid = (value, prefix) => typeof value === 'string' && value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value) && value.length > prefix.length && value.length <= 512;
const timestampValid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const pairingRoute = '/api/business/executors/device-pairings';
const terminalPairing = new Map([
 ['pairing_denied', [410, 'refused in the browser']],
 ['pairing_expired', [410, 'expired']],
 ['pairing_used', [410, 'already used']],
 ['pairing_unknown', [401, 'unknown']],
 ['business_paused', [409, 'paused because the Business is paused']],
]);

function validateDevicePairing(value, origin, businessId) {
 const uri = `${origin}/business/${encodeURIComponent(businessId)}/pair`;
 if (!value || !secretValid(value.device_code, 'bz_pairing_') || typeof value.user_code !== 'string' || !shortCode.test(value.user_code)
  || value.verification_uri !== uri || value.business_id !== businessId
  || value.verification_uri_complete !== undefined && value.verification_uri_complete !== `${uri}#${value.user_code}`
  || !intervalValid(value.interval) || !timestampValid(value.expires_at)) throw Error('Business server returned an invalid device pairing response.');
}

async function connectDevice({ business, origin, timeout } = {}) {
 const stop = new AbortController();
 const interrupt = () => stop.abort('SIGINT'), terminate = () => stop.abort('SIGTERM');
 process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
 let pending, resume, timer, unlock;
 try {
  await checkStateWritable();
  unlock = await lockPairing(stop.signal);
  const stored = await loadState();
  pending = await loadPending();
  origin = originUrl(origin ?? stored?.origin ?? pending?.origin);
  business = identifier(business ?? pending?.businessId);
  if (stored) {
   if (stored.revoked) throw Error(`This computer was ${revokedText(stored)}`);
   if (stored.origin !== origin || stored.businessId !== business) throw Error(`This state folder is connected to Business ${identifier(stored.businessId)} at ${originUrl(stored.origin)}. Run disconnect, or use another RER_BUSINESS_STATE_DIR.`);
   const credential = await createCredentialStore().get(deviceCredentialHandle(stored));
   if (!credential) throw Error(`This computer's Business credential is missing from ${credentialLocation()}. Run disconnect, then connect again.`);
   await unlock(); unlock = undefined;
   return await connected(new Api(origin, credential), stored, { reconnecting: true });
  }
  if (pending && Date.parse(pending.flow === 'device' ? pending.keep_until : pending.expires_at) <= Date.now()) { await clearPending(); pending = null; }
  if (pending && (pending.flow !== 'device' || pending.origin !== origin || pending.businessId !== business)) throw Error('Business is already waiting for another pairing. Resume that command, or run business disconnect before joining another Business.');
  if (pending) {
   validateDevicePairing({ ...pending, business_id: pending.businessId }, origin, business);
   if (!timestampValid(pending.keep_until) || Date.parse(pending.keep_until) > Date.parse(pending.expires_at) + approvalWindow) throw Error('The saved Business pairing is invalid. Run business disconnect, then connect again.');
  }
  // Both storage probes precede even the unauthenticated pairing start.
  const store = createCredentialStore();
  resume = `${rerCommand()} business connect --business ${business} --origin ${origin}${timeout === undefined ? '' : ` --timeout ${timeout}`}`;
  try { await store.check(); }
  catch (error) {
   const outside = error.sandboxRefused ? ` Approve this command outside the sandbox: ${resume}. Every other business command runs inside the sandbox.` : '';
   throw Error(`${error.message}${outside} ${pending ? 'The saved pairing was kept.' : 'Nothing was sent; no pairing was started.'}`);
  }
  const api = new Api(origin);
  if (!pending) {
   const name = deviceName(), folder = workingFolder();
   const response = await api.post(pairingRoute, {
    business_id: business, os: operatingSystem(), agent_kind: agentKind(), capabilities,
    ...(name ? { device_name: name } : {}), ...(folder ? { working_folder: folder } : {}),
   }, { signal: stop.signal, withStatus: true, quiet: true });
   const result = response?.body;
   validateDevicePairing(result, origin, business);
   if (response.status !== 201 || !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 900
    || Date.parse(result.expires_at) <= Date.now() || Date.parse(result.expires_at) > Date.now() + 900_000) throw Error('Business server returned an invalid device pairing lifetime.');
   pending = { flow: 'device', origin, businessId: business, device_code: result.device_code, user_code: result.user_code,
    verification_uri: result.verification_uri, interval: result.interval, expires_at: result.expires_at,
    keep_until: new Date(Date.parse(result.expires_at) + approvalWindow).toISOString(), next_poll_at: Date.now() + result.interval * 1000 };
   await savePending(pending);
  }
  await unlock(); unlock = undefined;
  // One write puts the fixed lines first, even without a TTY. Never echo the
  // code elsewhere in prose or errors; the fragment is not sent to a server.
  process.stdout.write(`Code: ${pending.user_code}\nApprove at: ${pending.verification_uri}#${pending.user_code}\nOpen the link signed in as an owner, check the code, then approve.\nWaiting until ${clock(pending.expires_at)}. Keep this command running.\nRun this same command again to keep waiting (same code).\n`);
  if (timeout !== undefined) timer = setTimeout(() => stop.abort('timeout'), timeout * 1000);
  while (!stop.signal.aborted) {
   if (Date.now() >= Date.parse(pending.keep_until)) { await clearPending(); throw Error('Business pairing expired (pairing_expired). Run connect again.'); }
   await pause(Math.max(0, (pending.next_poll_at ?? Date.now() + pending.interval * 1000) - Date.now()), stop.signal);
   const response = await api.post(`${pairingRoute}/poll`, { device_code: pending.device_code }, { signal: stop.signal, withStatus: true, quiet: true });
   const result = response?.body;
   if (response?.status === 200 && result?.status === 'paired') {
    // The one successful response is consumed even when a local write fails.
    try {
     if (!secretValid(result.device_credential, 'bz_device_') || result.business_id !== business || !timestampValid(result.idle_expires_at)) throw Error('Business server returned an invalid device credential.');
     const folder = workingFolder();
     const state = { version: 1, credentialVersion: 2, origin, businessId: business, executorId: identifier(result.executor_id), vendorHandles: [], awakeConsent: false, ...(folder ? { workingFolder: folder } : {}) };
     const handle = credentialHandle(origin, business);
     await store.set(handle, result.device_credential);
     try { await saveState(state); } catch (error) { await store.delete(handle); throw error; }
     await clearPending();
     process.stdout.write(`Approved. Device credential stored in ${credentialLocation()}.\n`);
     return await connected(new Api(origin, result.device_credential), state);
    } finally { await clearPending(); }
   }
   if (response?.status !== 202 || !['authorization_pending', 'slow_down'].includes(result?.status)
    || !intervalValid(result.interval) || result.interval < pending.interval || !timestampValid(result.expires_at)
    || result.status === 'slow_down' && result.interval < Math.min(60, pending.interval + 5)) throw Error('Business server returned an invalid device pairing status.');
   pending = { ...pending, interval: result.interval, next_poll_at: Date.now() + result.interval * 1000 };
   await savePending(pending);
  }
 } catch (error) {
  if (!stop.signal.aborted) {
   const ended = terminalPairing.get(error.code);
   if (ended && error.status === ended[0]) { await clearPending(); throw Error(`Business pairing ${ended[1]} (${error.code}). Run connect again.`); }
   throw error;
  }
 } finally {
  clearTimeout(timer);
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  await unlock?.();
 }
 if (!pending) throw new Stopped('Stopped before starting a Business pairing. Run connect again.', stop.signal.reason === 'SIGTERM' ? 143 : 130);
 if (stop.signal.reason === 'timeout') throw new Stopped(`Still waiting for approval until ${clock(pending.expires_at)}. Run this same command again to keep waiting (same code).`, 75);
 throw new Stopped(`Stopped waiting for approval. The pairing is saved: run ${resume} to resume it.`, stop.signal.reason === 'SIGTERM' ? 143 : 130);
}

// The first device-authenticated request activates the computer and applies
// the owner's choices; later choices reach it through run and next.
async function connected(api, state, options) {
 const { serviceInstalled } = await applyChoices(api, state, options);
 process.stdout.write(`This computer is connected to Business at ${state.origin}.\n`);
 if (serviceInstalled || state.applied?.installService === true) process.stdout.write('The background service works tasks after this chat ends.\n');
 process.stdout.write(`Run ${businessCommand('next')} to apply the owner's latest choices and see the next task.\n`);
}

export function localRoot(path) {
 if (typeof path !== 'string' || !path || path.includes('\0')) throw Error('Task has an invalid consented scan root.');
 return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
