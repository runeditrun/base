import { chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadState, stateDirectory } from './state.mjs';
import { serversDirectory } from '../server-registry.mjs';
import { alive } from '../../modules/job-queue/identity.mjs';

const carryPath = checkout => join(checkout, '.rer/local/business.json');
const registryPath = () => join(stateDirectory(), 'carried.json');
async function readJson(path) {
 try { return JSON.parse(await readFile(path, 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function recordedCheckouts() {
 const recorded = await readJson(registryPath()) ?? [];
 if (!Array.isArray(recorded)) throw Error('the carry registry is invalid');
 return recorded;
}
async function atomicJson(path, value) {
 const directory = dirname(path), temporary = join(directory, `${randomUUID()}.tmp`);
 await mkdir(directory, { recursive: true, mode: 0o700 });
 await chmod(directory, 0o700);
 try {
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function regular(path, directory = false, optional = false) {
 let info;
 try { info = await lstat(path); }
 catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
 if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw Error('the carry path is linked or not a regular file');
 return true;
}
export async function firstParty(checkout) {
 if (typeof checkout !== 'string' || !isAbsolute(checkout)) return false;
 await regular(checkout, true);
 await regular(join(checkout, 'OPERATIONS.json'));
 return (await readJson(join(checkout, 'OPERATIONS.json')))?.seedContract?.profile === 'first-party';
}

// This file is generated Business carry, not an app's own settings. Its supported
// profile values remain carry-owned; unknown documents and foreign carries do not.
function ownsCarry(prior, carry) {
 return prior && !Array.isArray(prior) && prior.version === carry.version
  && prior.origin === carry.origin && prior.business_id === carry.business_id && prior.business_url === carry.business_url
  && typeof prior.name === 'string' && (prior.legal_name === null || typeof prior.legal_name === 'string')
  && (prior.accent === null || typeof prior.accent === 'string' && /^#[0-9a-f]{6}$/i.test(prior.accent))
  && (prior.logo_url === null || typeof prior.logo_url === 'string') && typeof prior.refreshed_at === 'string'
  && Object.keys(prior).length === Object.keys(carry).length + 1 && Object.keys(carry).every(key => Object.hasOwn(prior, key));
}

export async function writeCarry(checkout, carry, { existingOnly = false } = {}) {
 if (!await firstParty(checkout)) throw Error('the checkout is not first-party');
 const root = resolve(checkout), path = carryPath(root);
 for (const directory of [join(root, '.rer'), dirname(path)]) await regular(directory, true, !existingOnly);
 const exists = await regular(path, false, !existingOnly);
 const prior = exists ? await readJson(path) : null;
 if (exists && !ownsCarry(prior, carry)) throw Error('the existing file is not a carry for this paired Business');
 const checkouts = await recordedCheckouts();
 // Record custody before the write, so disconnect can clean up even after a crash.
 if (!checkouts.includes(root)) await atomicJson(registryPath(), [...checkouts, root]);
 if (prior && Object.keys(carry).every(key => prior[key] === carry[key])) {
  for (const [file, mode] of [[dirname(path), 0o700], [path, 0o600]]) {
   if (((await stat(file)).mode & 0o777) !== mode) await chmod(file, mode);
  }
  return false;
 }
 await atomicJson(path, { ...carry, refreshed_at: new Date().toISOString() });
 return true;
}

// The same read-only liveness check as the installed launcher's liveServers.
// Keep it portable: vendored Business commands have no global launcher files.
async function liveCheckouts() {
 const registry = await readJson(join(serversDirectory(), 'state.json'));
 const checkouts = [];
 for (const record of registry?.running ?? []) {
  let live = true;
  try { live = await alive(record.owner); } catch { /* Unverifiable identities stay live, as in the registry. */ }
  if (live) checkouts.push(record.checkout);
 }
 return [...new Set(checkouts)];
}

export async function carryCheckouts(refused) {
 const checkouts = new Map();
 try { for (const checkout of await recordedCheckouts()) checkouts.set(checkout, { checkout, live: false }); }
 catch (error) { refused(error); }
 try { for (const checkout of await liveCheckouts()) checkouts.set(checkout, { checkout, live: true }); }
 catch (error) { refused(error); }
 return [...checkouts.values()];
}

export async function removeCarries() {
 const state = await loadState();
 if (!state?.origin || !state.businessId) return;
 const carry = { version: 1, origin: state.origin, business_id: state.businessId,
  business_url: `${state.origin}/business/${encodeURIComponent(state.businessId)}`,
  name: null, legal_name: null, accent: null, logo_url: null };
 const recorded = await recordedCheckouts();
 for (const checkout of new Set([...recorded, ...await liveCheckouts()])) {
  try {
   if (!await firstParty(checkout)) continue;
   for (const directory of [join(checkout, '.rer'), dirname(carryPath(checkout))]) await regular(directory, true);
   if (await regular(carryPath(checkout), false, true) && ownsCarry(await readJson(carryPath(checkout)), carry)) await unlink(carryPath(checkout));
  } catch (error) {
   // Disconnect must still clean eligible checkouts when an old one was removed,
   // linked, repurposed or became unreadable. Leave unrelated files untouched.
   if (!['ENOENT', 'ENOTDIR'].includes(error.code) && error.message !== 'the carry path is linked or not a regular file' && !(error instanceof SyntaxError)) throw error;
  }
 }
}
