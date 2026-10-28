import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { taskPath } from './api.mjs';
import { assertChunk } from './outbound.mjs';
import { createCredentialStore } from './keychain.mjs';
import { exportVendor, VENDORS, KEYED_VENDORS, VENDOR_CAPABILITIES, VendorExportError } from './vendors/index.mjs';
import { exportInputs, inputNeeds } from './export-inputs.mjs';
import { businessCommand } from './invocation.mjs';

// What every vendor task that writes into an app's import door shares
// (modules/import-kit/src/door): the claimed grant's door, one RER-signed grant
// per door request, the owner's read-only key from OS credential storage, the
// shipped adapter into a private 0600 bundle, and 64 KiB chunks.

// The door's upload unit ("Requests"): every chunk is exactly 64 KiB except the last.
const CHUNK_BYTES = 65_536;
const DOOR_RESPONSE_BYTES = 4 * 1024 * 1024;
// The catalogue names the platform builds vendor task titles from.
export const vendorNames = Object.freeze({ sentry: 'Sentry', uptimerobot: 'UptimeRobot', pagerduty: 'PagerDuty', calendly: 'Calendly', sorry: 'Sorry' });
/** Whether a vendor's export needs the owner's read-only key (Sorry's public page does not). */
export const keyed = vendor => KEYED_VENDORS.includes(vendor);
export const vendorHandle = vendor => `vendor:${vendor}:read`;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
// The door identifiers Business accepts in a task's outputs (platform business/imports.ts).
export const DOOR_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
export const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const plural = (value, word) => `${value} ${word}${value === 1 ? '' : 's'}`;

/** A vendor task that cannot go on until someone else acts. The supervisor tells
 * Business with `question`, hands the lease back as paused and says `message`. */
export class ExportWaiting extends Error {
 constructor(message, question, { keyMissing = null } = {}) { super(message); this.question = question; this.keyMissing = keyMissing; }
}

// The platform's task titles (business/task-titles.ts) for the kinds that name a vendor.
const titles = {
 'export.vendor': name => `Export ${name} history`,
 'catchup.vendor': name => `Bring over recent ${name} changes`,
 'switchoff.archive': name => `Archive ${name} before switching it off`,
 'freeze.vendor': name => `Freeze ${name} before the switch`,
 'switchoff.cancel': name => `Cancel ${name}`,
};
/** The shipped vendor a task names, read from its catalogue title
 * (`Export UptimeRobot history`), or null. Run trusts only the grant's namespace. */
export function titledVendor(kind, title) {
 if (!Object.hasOwn(titles, kind)) return null;
 return VENDORS.find(vendor => title === titles[kind](vendorNames[vendor])) ?? null;
}

const keyCommand = vendor => businessCommand(`vendor-key add ${vendor ?? '<vendor>'}`);
/** The owner-typed step that keeps a vendor's read-only key on this computer. */
export function keyStep(vendor) {
 return `ask the owner to type this in their own terminal, outside any agent sandbox (it asks for the key with hidden input; never put a key in chat, a command or a file):\n  ${keyCommand(vendor)}`;
}

const unavailableWords = {
 'vendor-not-in-catalogue': 'this tool has no shipped export',
 'no-linked-installation': 'Business has not set up the app this tool moves into',
 'ambiguous-target-installation': 'more than one app could receive this export',
 'installation-import-origin-unavailable': "the app's address is not known yet",
 'owner-claim-keys-unconfigured': 'Business cannot sign import grants yet',
 'import-door-off': "the app's import door is off",
 'installation-owner-claim-unconfigured': "the app's import door does not trust Business yet",
 'door-trust-keys-stale': "the app's import door holds old Business keys",
 'owner-not-claimed': 'the owner has not claimed the app yet',
 'connected-seed-import-required': "the app's import door is not ready",
};

/** The claimed grant's door: its origin and byte quota. */
function destination(task, grant) {
 if (grant.available === false || typeof grant.destination === 'string' && grant.destination.startsWith('unavailable:')) {
  const reason = Object.hasOwn(unavailableWords, grant.reason) && grant.destination === `unavailable:${grant.reason}` ? grant.reason : 'connected-seed-import-required';
  throw new ExportWaiting(`Business vendor export unavailable: ${reason} (${unavailableWords[reason]}). Task released as paused.`, 'connected_runner_required');
 }
 let url;
 try { url = new URL(grant.destination); } catch { throw Error('Business returned an invalid import destination.'); }
 if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback(url.hostname)) || url.username || url.password || url.search || url.hash
  || url.pathname !== '/api/rer/import/uploads' || grant.import_grants !== taskPath(task.id, 'import-grants')
  || !Number.isSafeInteger(grant.quota_bytes) || grant.quota_bytes < 1 || grant.quota_bytes > 300_000_000) throw Error('Business returned an invalid import destination.');
 return { origin: url.origin, quota: grant.quota_bytes };
}

/** Inputs the shipped adapter needs beyond the key: the leased task's own
 * non-secret `export_inputs`. A task that does not carry them yet waits for
 * Business (which asks the owner when its evidence is missing). */
function adapterInputs(vendor, task) {
 const inputs = exportInputs(vendor, task);
 if (inputs) return inputs;
 const needs = vendor === 'calendly' ? 'an import door that takes its folder of files' : `${inputNeeds[vendor]}, which this task does not carry yet`;
 throw new ExportWaiting(`Business vendor export for ${vendorNames[vendor]} needs ${needs}. Task released as paused.`, 'configuration_required');
}

/** One RER-signed import grant for one door request. `review` asks for a
 * catch-up plan grant without the owner's standing approval; a plan grant
 * Business minted under that approval says so with `catchup: 'bounded'`. */
async function doorGrant(lease, action, origin, vendor, { review = false } = {}) {
 const grant = await lease.importGrant(action, review ? { review: true } : {});
 if (!grant || grant.action !== action || grant.destination !== new URL(`/api/rer/import/${action}`, origin).href
  || typeof grant.authorization !== 'string' || grant.authorization.length > 8192 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant.authorization)
  || !VENDORS.includes(grant.namespace) || vendor && grant.namespace !== vendor || !(Date.parse(grant.expires_at) > Date.now())
  || Object.hasOwn(grant, 'catchup') && (grant.catchup !== 'bounded' || action !== 'plan' || review)) throw Error('Business returned an invalid import grant.');
 return grant;
}

/** POST one request to the app's door. Only the door's error code is ever
 * shown: its bodies can hold vendor records. */
export async function door(grant, body, signal) {
 const action = grant.action;
 let response;
 try {
  response = await fetch(grant.destination, { method: 'POST', redirect: 'error', body: JSON.stringify(body),
   headers: { authorization: grant.authorization, 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
 } catch (error) {
  if (signal.aborted) throw signal.reason;
  const code = error?.cause?.code ?? error?.code;
  throw Error(`Could not reach the app's import door at ${new URL(grant.destination).origin} (${error?.name === 'TimeoutError' ? 'no answer within 30 seconds' : typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : 'the request failed'}).`);
 }
 const chunks = []; let size = 0;
 for await (const chunk of response.body ?? []) {
  size += chunk.byteLength;
  if (size > DOOR_RESPONSE_BYTES) { await response.body.cancel().catch(() => {}); throw Error(`The app's import door answered the ${action} request with more than the CLI reads.`); }
  chunks.push(chunk);
 }
 let result = null;
 try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Judged below. */ }
 if (!response.ok) {
  // A door code is snake_case, sometimes with one named reason (`catchup_requires_proposal:source_records_gone`).
  const doorCode = typeof result?.error === 'string' && /^[a-z][a-z0-9_]{0,79}(?::[a-z][a-z0-9_]{0,79})?$/.test(result.error) ? result.error : null;
  throw Object.assign(Error(`The app's import door refused the ${action} request (HTTP ${response.status}${doorCode ? `: ${doorCode}` : ''}).`), { doorStatus: response.status, doorCode });
 }
 if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error(`The app's import door returned an invalid ${action} answer.`);
 return result;
}

/** Run the shipped adapter into a private 0600 bundle file, checking every
 * item with the outbound detector before it is written. */
async function exportBundle({ vendor, key = null, inputs, path, quota, signal }) {
 await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
 const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 const digest = createHash('sha256'); let size = 0;
 try {
  for await (const item of exportVendor(vendor, { key, inputs, signal })) {
   assertChunk(item.bytes, key ? [key] : []);
   size += item.bytes.length;
   if (size > quota) throw Error(`Business vendor export is larger than the app's import door accepts (${quota} bytes). Nothing was uploaded.`);
   digest.update(item.bytes);
   await file.write(item.bytes);
  }
  await file.sync();
 } catch (error) {
  if (!(error instanceof VendorExportError)) throw error;
  if (error.code === 'HTTP_REFUSED' && [401, 403].includes(error.status) && key) {
   throw new ExportWaiting(`${vendorNames[vendor]} refused the stored read-only key (HTTP ${error.status}). To replace it, ${keyStep(vendor)}`, 'owner_required');
  }
  throw Error(`${vendorNames[vendor]} export stopped (${error.code}${error.status ? `, HTTP ${error.status}` : ''}). Nothing was uploaded.`);
 } finally { await file.close(); }
 if (!size) throw Error(`${vendorNames[vendor]} export produced nothing to upload.`);
 return { size, sha256: digest.digest('hex') };
}

async function readChunk(path, index, size) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const length = Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES), bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, index * CHUNK_BYTES);
  if (bytesRead !== length) throw Error('Business vendor export bundle changed while uploading.');
  return bytes;
 } finally { await file.close(); }
}

/** A door plan's preview of exactly this bundle: its ids and the door's counts. */
export function checkedPreview(preview, bundle) {
 const summary = preview.summary ?? {}, [records, created, updated, unchanged, gone] = ['sourceRecords', 'created', 'updated', 'unchanged', 'gone'].map(name => count(summary[name]));
 const rejected = count(preview.counts?.rejected);
 if (typeof preview.planId !== 'string' || !DOOR_ID.test(preview.planId) || !/^[a-f0-9]{64}$/.test(preview.fingerprint ?? '')
  || preview.bundleSha256 !== bundle.sha256 || [records, created, updated, unchanged, gone, rejected].includes(null)) throw Error("The app's import door returned an invalid preview.");
 return { records, created, updated, unchanged, gone, rejected };
}

/**
 * The shared start of a claimed vendor door task: the claimed grant's door, the
 * vendor its first grant names, the owner's key from the OS store, the shipped
 * adapter into a private 0600 bundle, then the bundle in 64 KiB chunks, each with
 * a fresh grant. A vendor that needs no key (a public status page) reads none.
 * `finish` gets the uploaded bundle and returns `{outputs, said}`:
 * the task then completes with those outputs (identifiers only, which Business
 * checks against the door itself) and `said` is the line to say. The bundle file
 * is removed on every exit. `doing(name, origin, keyed)` is said first.
 */
export async function withUploadedBundle({ lease, task, grant: claimedGrant, directory, say, doing }, finish) {
 const signal = lease.signal, { origin, quota } = destination(task, claimedGrant);
 // The first grant names the vendor (its namespace); it then carries chunk 0.
 let spare = await doorGrant(lease, 'uploads', origin, null);
 const vendor = spare.namespace, name = vendorNames[vendor], capability = VENDOR_CAPABILITIES[vendor];
 const fresh = async (action, options) => {
  if (action === 'uploads' && spare && Date.parse(spare.expires_at) - Date.now() > 60_000) { const grant = spare; spare = null; return grant; }
  spare = null;
  return doorGrant(lease, action, origin, vendor, options);
 };
 const inputs = adapterInputs(vendor, task);
 let key = keyed(vendor) ? await createCredentialStore().get(vendorHandle(vendor)) : null;
 if (keyed(vendor) && !key) throw new ExportWaiting(`Business vendor export needs the owner's read-only ${name} key on this computer: ${keyStep(vendor)}\nThen run ${businessCommand('run')} again.`, 'owner_required', { keyMissing: vendor });
 const path = join(directory, `export-${hash(task.id).slice(0, 32)}.bundle`);
 try {
  say(doing(name, origin, keyed(vendor)));
  let bundle;
  try { bundle = await exportBundle({ vendor, key, inputs, path, quota, signal }); } finally { key = undefined; }
  const total = Math.ceil(bundle.size / CHUNK_BYTES);
  let uploadId;
  for (let index = 0; index < total; index++) {
   signal.throwIfAborted();
   const bytes = await readChunk(path, index, bundle.size);
   const result = await door(await fresh('uploads'), { ...(uploadId ? { uploadId } : {}), name: capability.output, bundleSha256: bundle.sha256,
    totalBytes: bundle.size, totalChunks: total, index, chunkSha256: hash(bytes), base64: bytes.toString('base64') }, signal);
   if (typeof result.uploadId !== 'string' || !DOOR_ID.test(result.uploadId) || uploadId && result.uploadId !== uploadId
    || result.bundleSha256 !== bundle.sha256 || index === total - 1 && result.complete !== true) throw Error("The app's import door returned an invalid upload answer.");
   uploadId = result.uploadId;
   await lease.checkpointSaved({ page: index + 1, total, bytes_done: Math.min((index + 1) * CHUNK_BYTES, bundle.size), progress: Math.floor((index + 1) / total * 90) });
  }
  const { outputs, said } = await finish({ vendor, name, origin, uploadId, bundle, fresh });
  await lease.checkpointSaved({ page: total, total, bytes_done: bundle.size, progress: 100 });
  await lease.complete(outputs);
  return said;
 } finally {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
 }
}
