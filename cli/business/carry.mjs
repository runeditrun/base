import { Api } from './api.mjs';
import { createCredentialStore } from './keychain.mjs';
import { credentialHandle, loadState } from './state.mjs';
import { localCause } from './errors.mjs';
import { carryCheckouts, firstParty, writeCarry } from './carry-files.mjs';
export { removeCarries } from './carry-files.mjs';

const launched = Symbol.for('rer.business.carry.launched');

export function buildCarry(state, self) {
 const business = self?.business;
 if (!business) return null; // Older platforms have no local identity to carry.
 if (business.id !== state.businessId) throw Error('the response names another Business');
 if (typeof business.name !== 'string' || [...business.name].length < 1 || [...business.name].length > 200
  || business.legal_name !== null && typeof business.legal_name !== 'string') throw Error('the Business profile is invalid');
 let logo = null;
 try {
  const url = new URL(business.logo_url);
  if (url.protocol === 'https:' && !url.username && !url.password) logo = business.logo_url;
 } catch { /* An absent or invalid logo is carried as null. */ }
 return { version: 1, origin: state.origin, business_id: state.businessId,
  business_url: `${state.origin}/business/${encodeURIComponent(state.businessId)}`,
  name: business.name, legal_name: business.legal_name,
  accent: typeof business.brand_color === 'string' && /^#[0-9a-f]{6}$/i.test(business.brand_color) ? business.brand_color.toLowerCase() : null,
  logo_url: logo };
}

function warning(origin, error, checkout) {
 // Do not echo server text, response fields or transport messages: they can contain credentials.
 const reason = error.status ? `the server refused the request (HTTP ${error.status})`
  : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'the server did not answer within 5 seconds'
  : error.message?.startsWith('Could not reach the Business server at ') ? 'the server is unreachable'
  : error.message === 'credential unavailable' ? 'the Business credential is unavailable in OS credential storage'
  : localCause(error) ?? (['the response names another Business', 'the Business profile is invalid', 'the checkout is not first-party', 'the carry path is linked or not a regular file', 'the existing file is not a carry for this paired Business', 'the carry registry is invalid'].includes(error.message) ? error.message : 'the Business profile could not be refreshed');
 process.stderr.write(`Business carry at ${origin}${checkout ? ` for ${JSON.stringify(checkout)}` : ''}: ${reason}; keeping the local carry.\n`);
}

export async function carryCheckIn(state, self) {
 try {
  if (!state?.origin || !state.businessId || !state.executorId || state.revoked) return;
  const carry = buildCarry(state, self);
  if (!carry) return;
  const checkouts = [], unchanged = [];
  let failed = 0;
  const refused = (error, checkout) => { failed++; warning(state.origin, error, checkout); };
  for (const { checkout, live } of await carryCheckouts(refused)) {
   try {
    const changed = await writeCarry(checkout, carry, { existingOnly: !live });
    (changed ? checkouts : unchanged).push(checkout);
   } catch (error) { refused(error, checkout); }
  }
  return { name: carry.name, checkouts, unchanged, failed };
 } catch (error) { warning(state.origin, error); }
}

export async function refreshCarry(api, state, { checkout, signal } = {}) {
 try {
  const self = await api.request('GET', '/api/business/executors/self', undefined, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  if (checkout) {
   const carry = buildCarry(state, self);
   if (carry) await writeCarry(checkout, carry);
  } else await carryCheckIn(state, self);
 } catch (error) { if (!signal?.aborted) warning(state.origin, error); }
}

export async function refreshCheckout(checkout) {
 if (process.env.RER_DEMO === '1' || globalThis[launched] === checkout) return;
 globalThis[launched] = checkout; // The checkout's pinned launcher may enter main again in this process.
 let state;
 try {
  if (!await firstParty(checkout)) return;
  state = await loadState();
  if (!state?.origin || !state.businessId || !state.executorId || state.revoked) return;
  const credential = await createCredentialStore().get(credentialHandle(state.origin));
  if (!credential) throw Error('credential unavailable');
  await refreshCarry(new Api(state.origin, credential), state, { checkout });
 } catch (error) { warning(state?.origin ?? 'the paired origin', error); }
}

// Reuse the supervisor's existing refresh cycle for live and previously carried apps.
export async function startCarryRefresh(api, state, signal) {
 const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
 let pending = Promise.resolve(), busy = false;
 const timer = setInterval(() => {
  if (busy || combined.aborted) return;
  busy = true;
  pending = refreshCarry(api, state, { signal: combined }).finally(() => { busy = false; });
 }, 60_000);
 return async () => { clearInterval(timer); controller.abort(); await pending; };
}
