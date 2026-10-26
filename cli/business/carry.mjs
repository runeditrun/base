import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Api } from './api.mjs';
import { createCredentialStore } from './keychain.mjs';
import { credentialHandle, loadState, stateDirectory } from './state.mjs';
import { localCause } from './errors.mjs';
import { serversDirectory } from '../server-registry.mjs';
import { alive } from '../../modules/job-queue/identity.mjs';

const carryPath = checkout => join(checkout, '.rer/local/business.json');
const launched = Symbol.for('rer.business.carry.launched');

async function readJson(path) {
 try { return JSON.parse(await readFile(path, 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(path, value) {
 const directory = dirname(path), temporary = join(directory, `${randomUUID()}.tmp`);
 await mkdir(directory, { recursive: true, mode: 0o700 });
 await chmod(directory, 0o700);
 try {
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

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

export async function writeCarry(checkout, carry) {
 const root = resolve(checkout), path = carryPath(root), record = join(stateDirectory(), 'carried.json');
 const checkouts = await readJson(record) ?? [];
 // Record custody before the write, so disconnect can clean up even after a crash.
 if (!checkouts.includes(root)) await atomicJson(record, [...checkouts, root]);
 let prior;
 try { prior = await readJson(path); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
 const values = { ...prior };
 delete values.refreshed_at;
 if (Object.keys(values).length === Object.keys(carry).length && Object.keys(carry).every(key => values[key] === carry[key])) {
  await chmod(dirname(path), 0o700); await chmod(path, 0o600);
  return false;
 }
 await atomicJson(path, { ...carry, refreshed_at: new Date().toISOString() });
 return true;
}

async function firstParty(checkout) {
 return typeof checkout === 'string' && isAbsolute(checkout)
  && (await readJson(join(checkout, 'OPERATIONS.json')))?.seedContract?.profile === 'first-party';
}

// The same read-only registry view as the installed launcher's liveServers.
// Keep this reader in the exported CLI too: vendored Business commands have no global launcher files.
async function liveCheckouts() {
 const registry = await readJson(join(serversDirectory(), 'state.json'));
 const checkouts = [];
 for (const record of registry?.running ?? []) {
  let live = true;
  try { live = await alive(record.owner); } catch { /* Unverifiable identities stay live, as in the registry. */ }
  if (live) {
   try { if (await firstParty(record.checkout)) checkouts.push(record.checkout); }
   catch { /* A checkout with an unreadable descriptor is not a carry destination. */ }
  }
 }
 return [...new Set(checkouts)];
}

function warning(origin, error) {
 // Do not echo server text, response fields or transport messages: they can contain credentials.
 const reason = error.status ? `the server refused the request (HTTP ${error.status})`
  : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'the server did not answer within 5 seconds'
  : error.message?.startsWith('Could not reach the Business server at ') ? 'the server is unreachable'
  : error.message === 'credential unavailable' ? 'the Business credential is unavailable in OS credential storage'
  : localCause(error) ?? (['the response names another Business', 'the Business profile is invalid'].includes(error.message) ? error.message : 'the Business profile could not be refreshed');
 process.stderr.write(`Business carry at ${origin}: ${reason}; keeping the local carry.\n`);
}

export async function carryLive(state, self) {
 try {
  const carry = buildCarry(state, self);
  if (!carry) return;
  for (const checkout of await liveCheckouts()) {
   try { await writeCarry(checkout, carry); } catch (error) { warning(state.origin, error); }
  }
 } catch (error) { warning(state.origin, error); }
}

export async function refreshCarry(api, state, { checkout, signal } = {}) {
 try {
  const self = await api.request('GET', '/api/business/executors/self', undefined, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  if (checkout) {
   const carry = buildCarry(state, self);
   if (carry) await writeCarry(checkout, carry);
  } else await carryLive(state, self);
 } catch (error) { if (!signal?.aborted) warning(state.origin, error); }
}

export async function refreshCheckout(checkout) {
 if (process.env.RER_DEMO === '1' || globalThis[launched] === checkout) return;
 globalThis[launched] = checkout; // The checkout's pinned launcher may enter main again in this process.
 let state;
 try {
  if (!await firstParty(checkout)) return;
  state = await loadState();
  if (!state?.origin || !state.businessId || !state.executorId) return;
  const credential = await createCredentialStore().get(credentialHandle(state.origin));
  if (!credential) throw Error('credential unavailable');
  await refreshCarry(new Api(state.origin, credential), state, { checkout });
 } catch (error) { warning(state?.origin ?? 'the paired origin', error); }
}

export async function startCarryRefresh(api, state, signal) {
 const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
 let pending = refreshCarry(api, state, { signal: combined });
 await pending;
 let busy = false;
 const timer = setInterval(() => {
  if (busy || combined.aborted) return;
  busy = true;
  pending = refreshCarry(api, state, { signal: combined }).finally(() => { busy = false; });
 }, 60_000);
 return async () => { clearInterval(timer); controller.abort(); await pending; };
}

export async function removeCarry(checkout) {
 await unlink(carryPath(checkout)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
export async function removeCarries() {
 const recorded = await readJson(join(stateDirectory(), 'carried.json')) ?? [];
 for (const checkout of new Set([...recorded, ...await liveCheckouts()])) await removeCarry(checkout);
}
