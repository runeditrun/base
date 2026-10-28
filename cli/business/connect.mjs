import { homedir } from 'node:os';
import { join } from 'node:path';
import { Api, originUrl, identifier, pause } from './api.mjs';
import { loadState, saveState, credentialHandle, loadPending, savePending, clearPending, checkStateWritable } from './state.mjs';
import { createCredentialStore } from './keychain.mjs';
import { applyChoices } from './choices.mjs';
import { rerCommand, businessCommand } from './invocation.mjs';
import { Stopped } from './errors.mjs';
import { agentKind, deviceName, workingFolder } from './device.mjs';
import { revokedText } from './local-commands.mjs';

// Approval moves the server's pairing expiry to ten minutes after approval, and
// approval can come up to the code's own expiry. Keep the pending pairing until
// then and let the server decide whether it was approved in time.
const approvalWindow = 600_000;

export const capabilities = ['discover.local', 'export.vendor:sentry', 'export.vendor:uptimerobot', 'export.vendor:pagerduty', 'export.vendor:calendly'];

const clock = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nothingSent = 'Nothing was sent, so the pairing code still works.';

/** Pair (or resume a saved pairing) and wait in the foreground until the owner
 * approves or refuses in the browser, or the code expires. Exit 0 means the
 * computer is active: its credential is stored and the server has seen it.
 */
export async function connect({ code, origin } = {}) {
 const stored = await loadState();
 let pending = await loadPending();
 origin = originUrl(origin ?? stored?.origin ?? pending?.origin);
 if (stored) {
  if (stored.revoked) throw Error(`This computer was ${revokedText(stored)}\nThen connect with a new code from ${stored.origin}/business.`);
  if (stored.origin !== origin) throw Error(`This computer is already connected to Business at ${stored.origin}. Run ${rerCommand()} business disconnect before connecting it elsewhere.`);
  const credential = await createCredentialStore().get(credentialHandle(origin));
  if (!credential) throw Error(`This computer's Business credential is missing from OS credential storage. Run ${rerCommand()} business disconnect, then connect again with a new code from ${origin}/business.`);
  await connected(new Api(origin, credential), stored, { reconnecting: true });
  return;
 }
 if (pending && Date.parse(pending.expires_at) <= Date.now()) { await clearPending(); pending = null; }
 if (pending && (pending.origin !== origin || code && pending.code !== code)) throw Error(`Business is already waiting for approval of another code${pending.origin === origin ? '' : ` at ${pending.origin}`}. Run ${rerCommand()} business connect to resume it, or ${rerCommand()} business disconnect to drop it before using another code.`);
 if (!pending && !code) throw Error(`Set up your business: Business shares your business name, logo and brand colour with apps that support it. Open ${origin}/business; sign up free there if you have no account. Choose what to share there. Back in this terminal, run this same command again with --code followed by the code you copied from that page.`);
 // Refuse before redeeming the one-use code or collecting an approval when this
 // session cannot keep the pairing or store the device credential.
 await checkStateWritable();
 const store = createCredentialStore(), handle = credentialHandle(origin);
 try { await store.get(handle); await store.check(); }
 catch (error) {
  const outside = error.sandboxRefused ? ` Approve this command outside the sandbox: ${rerCommand()} business connect${code ? ` --code ${code}` : ''} --origin ${origin}. Every other business command runs inside the sandbox.` : '';
  throw Error(`${error.message}${outside} ${pending ? 'The saved pairing was kept; run connect again once this is fixed.' : nothingSent}`);
 }

 // Ctrl-C or a stopped tool call never strands a pairing: the redeemed pairing
 // is saved before waiting, and a collected credential is stored before exit.
 const stop = new AbortController();
 const stopWith = signal => () => stop.abort(signal);
 const onInterrupt = stopWith('SIGINT'), onTerminate = stopWith('SIGTERM');
 process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
 try {
  const api = new Api(origin);
  if (!pending) {
   // The computer's plain name and the folder connect runs in help the owner
   // recognise this computer and prefill the scan folder; each is left out when empty.
   const name = deviceName(), folder = workingFolder();
   const response = await api.post('/api/business/executors/pair', {
    code, ...(name ? { device_name: name } : {}), ...(folder ? { working_folder: folder } : {}),
    os: process.platform === 'darwin' ? 'macos' : 'linux', agent_kind: agentKind(), capabilities,
   }).catch(error => { throw error.status === 401 ? Error(`Business did not accept code ${code}: it has expired or was already used${error.reason ? ` (the server said: ${error.reason})` : ''}. Create a new code in ${origin}/business.`) : error; });
   const expires = Math.min(Date.now() + 600_000, Date.parse(response?.expires_at));
   if (response?.status !== 'pending_approval' || !/^\d{6}$/.test(response.confirmation_number) || typeof response.pairing_token !== 'string' || !response.pairing_token || !Number.isFinite(expires) || expires <= Date.now()) throw Error('Business server returned an invalid pairing response.');
   pending = { origin, code, pairing_token: response.pairing_token, confirmation_number: response.confirmation_number, code_expires_at: new Date(expires).toISOString(), expires_at: new Date(expires + approvalWindow).toISOString() };
   await savePending(pending);
  }
  const resume = `${rerCommand()} business connect --origin ${origin}`;
  const until = pending.code_expires_at ? ` until ${clock(pending.code_expires_at)}, when the code expires` : ' until the code expires';
  process.stdout.write(`Confirmation number: ${pending.confirmation_number}\nCompare this number in the browser that created the code, then approve there.\nWaiting for approval in ${origin}/business${until}. Keep this command running.\nIf it stops, run ${resume} to resume this pairing.\n`);
  while (Date.now() < Date.parse(pending.expires_at)) {
   if (stop.signal.aborted) break;
   let result;
   try { result = await api.post('/api/business/executors/pair', { pairing_token: pending.pairing_token }, { signal: stop.signal }); }
   catch (error) {
    if (stop.signal.aborted) break;
    if ([401, 403, 410].includes(error.status)) {
     await clearPending();
     throw Error(`Business pairing ended without approval: the owner refused it, or the code expired${error.reason ? ` (the server said: ${error.reason})` : ''}. Create a new code in ${origin}/business and run connect with it.`);
    }
    throw error;
   }
   if (result?.status === 'paired') {
    if (typeof result.device_credential !== 'string') throw Error('Business server returned an invalid device credential.');
    const folder = workingFolder();
    const state = { version: 1, origin, businessId: identifier(result.business_id), executorId: identifier(result.executor_id), vendorHandles: [], awakeConsent: false, ...(folder ? { workingFolder: folder } : {}) };
    // No authenticated request (including activation) before both durable writes.
    await store.set(handle, result.device_credential);
    try { await saveState(state); } catch (error) { await store.delete(handle); throw error; }
    await clearPending();
    process.stdout.write('Approved. Device credential stored in OS credential storage.\n');
    await connected(new Api(origin, result.device_credential), state);
    return;
   }
   if (['denied', 'refused', 'expired'].includes(result?.status)) {
    await clearPending();
    throw Error(`Business pairing was ${result.status === 'expired' ? 'not approved before the code expired' : 'refused in the browser'}. Create a new code in ${origin}/business and run connect with it.`);
   }
   if (result?.status !== 'authorization_pending') throw Error('Business server returned an invalid pairing status.');
   try { await pause(Math.max(1, Math.min(5, Number(result.interval) || 5)) * 1000, stop.signal); } catch { break; }
  }
  if (stop.signal.aborted) {
   throw new Stopped(`Stopped waiting for approval. The pairing is saved: run ${resume} to resume it${pending.code_expires_at ? ` before ${clock(pending.code_expires_at)}` : ''}.`, stop.signal.reason === 'SIGTERM' ? 143 : 130);
  }
  await clearPending();
  throw Error(`Business pairing code expired before it was approved. Create a new code in ${origin}/business and run connect with it.`);
 } finally {
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
 }
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
