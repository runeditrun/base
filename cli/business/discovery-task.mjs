import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { identifier } from './api.mjs';
import { assertSignals } from './outbound.mjs';
import { scan } from './scan.mjs';

const PAGE_BYTES = 128 * 1024, QUOTA_BYTES = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Error(`Business discovery ${message}.`); };

// The scan command includes local counts and skip diagnostics. The executor
// upload contract accepts only the names-only signal projection.
function uploadDocument(result) {
 return { schema: result.schema, source: result.source, withheld: result.withheld,
  signals: result.signals.map(({ kind, value, locator, repo, class: sourceClass, observedAt, size, mtime }) => ({
   kind, value, locator, repo, class: sourceClass, observedAt, ...(size === undefined ? {} : { size, mtime }),
  })) };
}

function inputs(task, grant, checkpoint, stateDir) {
 if (!object(task) || task.kind !== 'discover.local' || !object(grant)) fail('requires a scoped local discovery grant');
 identifier(task.id); identifier(grant.id); identifier(grant.consent?.id);
 if (grant.task_id !== task.id || !integer(task.fence) || task.fence < 1 || grant.fence !== task.fence) fail('grant does not match the claimed task and fence');
 if (grant.destination !== `/api/business/tasks/${encodeURIComponent(task.id)}/uploads`) fail('grant has an invalid upload destination');
 if (!integer(grant.quota_bytes) || grant.quota_bytes < 1 || grant.quota_bytes > QUOTA_BYTES || !integer(grant.uploaded_bytes) || grant.uploaded_bytes > grant.quota_bytes) fail('grant has invalid byte limits');
 const paths = grant.consent.scope?.paths;
 if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || /[\u0000-\u001f\u007f]/u.test(path) || !(isAbsolute(path) || path.startsWith('~/')))) fail('consent must contain absolute or home-relative scoped paths');
 // Only the browser-authorized grant supplies roots. Canonicalize spelling and
 // order without following symlinks; scan itself refuses symlink ancestors.
 const roots = [...new Set(paths.map(path => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)))].sort();
 if (!isAbsolute(stateDir ?? '')) fail('requires an absolute private state directory');
 if (!object(checkpoint) || Object.keys(checkpoint).some(key => !['page', 'total', 'records_done', 'bytes_done', 'progress'].includes(key))) fail('checkpoint is invalid');
 for (const key of ['page', 'total', 'records_done', 'bytes_done']) if (checkpoint[key] !== undefined && !integer(checkpoint[key])) fail('checkpoint is invalid');
 if (checkpoint.progress !== undefined && (!integer(checkpoint.progress) || checkpoint.progress > 100)) fail('checkpoint progress is invalid');
 if (!checkpoint.page && (checkpoint.records_done || checkpoint.bytes_done)) fail('checkpoint lacks its acknowledged page');
 return { roots, identity: hash(JSON.stringify([task.id, grant.consent.id, roots])) };
}

function validateDocument(document) {
 if (!object(document) || document.schema !== 'rer-business-signals/1' || document.source !== 'local' || !Array.isArray(document.signals) || !integer(document.withheld) || Object.keys(document).some(key => !['schema', 'source', 'signals', 'withheld'].includes(key))) fail('snapshot document is invalid');
 const allowed = ['kind', 'value', 'locator', 'repo', 'class', 'observedAt', 'size', 'mtime'];
 for (const item of document.signals) {
  if (!object(item) || Object.keys(item).some(key => !allowed.includes(key)) || ['kind', 'value', 'locator', 'repo', 'observedAt'].some(key => typeof item[key] !== 'string') || !['live-use', 'trace'].includes(item.class) || item.size !== undefined && !integer(item.size) || item.mtime !== undefined && typeof item.mtime !== 'string') fail('snapshot signal is invalid');
 }
 assertSignals(document);
}

const pageDocument = (document, start, end) => ({ schema: document.schema, source: document.source, signals: document.signals.slice(start, end), withheld: start === 0 ? document.withheld : 0 });

function paginate(document) {
 const ends = [];
 let start = 0, bytes = Buffer.byteLength(JSON.stringify(pageDocument(document, 0, 0)));
 for (let index = 0; index < document.signals.length; index++) {
  const signalBytes = Buffer.byteLength(JSON.stringify(document.signals[index]));
  if (index - start >= 2000 || bytes + signalBytes + (index > start ? 1 : 0) >= PAGE_BYTES) {
   if (index === start) fail('signal exceeds the upload page bound');
   ends.push(index); start = index;
   bytes = Buffer.byteLength(JSON.stringify(pageDocument(document, start, start)));
  }
  bytes += signalBytes + (index > start ? 1 : 0);
  if (bytes >= PAGE_BYTES) fail('signal exceeds the upload page bound');
 }
 if (document.signals.length) ends.push(document.signals.length);
 return ends;
}

function pagesFrom(snapshot, identity, quota) {
 if (!object(snapshot) || snapshot.version !== 1 || snapshot.identity !== identity || !Array.isArray(snapshot.pageEnds)) fail('snapshot does not match this task and consent');
 validateDocument(snapshot.document);
 const pages = []; let start = 0, bytes = 0;
 for (const end of snapshot.pageEnds) {
  if (!integer(end) || end <= start || end > snapshot.document.signals.length) fail('snapshot pagination is invalid');
  const document = pageDocument(snapshot.document, start, end), size = Buffer.byteLength(JSON.stringify(document));
  if (size >= PAGE_BYTES) fail('snapshot exceeds the upload page bound');
  bytes += size;
  if (bytes > quota) fail('snapshot exceeds the consented upload quota');
  pages.push({ document, bytes: size, records: end - start }); start = end;
 }
 if (start !== snapshot.document.signals.length) fail('snapshot pagination is incomplete');
 return pages;
}

async function readSnapshot(path) {
 let file;
 try {
  file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const info = await file.stat();
  if (!info.isFile() || info.size > QUOTA_BYTES + 256 * 1024) fail('snapshot is not a bounded regular file');
  await file.chmod(0o600);
  let snapshot;
  try { snapshot = JSON.parse(await file.readFile('utf8')); }
  catch { fail('snapshot is unreadable; keep it intact and restart with a new consent'); }
  return snapshot;
 } catch (error) {
  if (error.code === 'ENOENT') return null;
  // Filesystem errors can contain names; never surface them as diagnostics.
  if (error.message?.startsWith('Business discovery ')) throw error;
  fail('could not read its private snapshot');
 } finally { await file?.close(); }
}

async function writeSnapshot(directory, path, snapshot) {
 const temporary = join(directory, `discovery-${randomUUID()}.tmp`);
 let file, directoryFile;
 try {
  file = await open(temporary, 'wx', 0o600);
  await file.writeFile(JSON.stringify(snapshot)); await file.sync(); await file.close(); file = undefined;
  await rename(temporary, path);
  directoryFile = await open(directory, constants.O_RDONLY);
  await directoryFile.sync();
 } catch { fail('could not durably save its private snapshot; no upload was started'); }
 finally {
  await file?.close(); await directoryFile?.close();
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') fail('could not clean up its temporary snapshot'); });
 }
}

function counts(pages, page) {
 const acknowledged = pages.slice(0, page);
 return { page, total: pages.length, records_done: acknowledged.reduce((sum, item) => sum + item.records, 0), bytes_done: acknowledged.reduce((sum, item) => sum + item.bytes, 0), progress: pages.length ? Math.floor(page / pages.length * 100) : 100 };
}

/** send adds the current fence/grant/token to the supplied upload payload.
 * The server checkpoint is authoritative. Keep the snapshot until the caller
 * receives completion acknowledgement, then invoke the returned cleanup().
 */
export async function runDiscovery({ task, grant, checkpoint = task?.checkpoint ?? {}, signal, send, saveCheckpoint, stateDir }) {
 signal?.throwIfAborted();
 const { roots, identity } = inputs(task, grant, checkpoint, stateDir);
 if (typeof send !== 'function' || typeof saveCheckpoint !== 'function') fail('requires upload and checkpoint callbacks');
 const path = join(stateDir, `discovery-${identity}.json`);
 try {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const info = await lstat(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('state directory must be private and regular');
  await chmod(stateDir, 0o700);
 } catch { fail('could not prepare its private state directory'); }
 let snapshot = await readSnapshot(path);
 if (!snapshot) {
  if (checkpoint.page > 0) fail('cannot resume acknowledged pages without the original snapshot; restore it or start a new consent');
  let document;
  try { document = uploadDocument(await scan(roots)); }
  catch { fail('could not read a consented local input; no upload was started'); }
  signal?.throwIfAborted();
  validateDocument(document);
  snapshot = { version: 1, identity, document, pageEnds: paginate(document) };
  pagesFrom(snapshot, identity, grant.quota_bytes);
  await writeSnapshot(stateDir, path, snapshot);
 }
 const pages = pagesFrom(snapshot, identity, grant.quota_bytes), page = checkpoint.page ?? 0;
 if (page > pages.length) fail('checkpoint is outside its saved pagination');
 if (grant.uploaded_bytes + pages.slice(page).reduce((sum, item) => sum + item.bytes, 0) > grant.quota_bytes) fail('remaining pages exceed the granted upload quota');
 const expected = counts(pages, page);
 for (const key of ['total', 'records_done', 'bytes_done']) {
  // A fresh server task can project zero counters before a plan exists.
  if (key === 'total' && page === 0 && checkpoint.total === 0) continue;
  if (checkpoint[key] !== undefined && checkpoint[key] !== expected[key]) fail('checkpoint disagrees with its saved snapshot');
 }
 for (let index = page; index < pages.length; index++) {
  signal?.throwIfAborted();
  // A renewed grant has a new idempotency namespace. Retries under the same
  // grant reuse the exact event id and immutable document bytes.
  const digest = hash(JSON.stringify([identity, grant.id, grant.fence, index, pages[index].document]));
  const eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const payload = { client_event_id: eventId, consent_id: grant.consent.id, document: pages[index].document };
  assertSignals(payload.document);
  if (Buffer.byteLength(JSON.stringify({ ...payload, fence: grant.fence, grant_id: grant.id })) > QUOTA_BYTES) fail('upload request exceeds the protocol bound');
  await send(grant.destination, payload);
  await saveCheckpoint(counts(pages, index + 1));
 }
 if (!pages.length) { signal?.throwIfAborted(); await saveCheckpoint(counts(pages, 0)); }
 return { ...counts(pages, pages.length), cleanup: async () => {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') fail('could not remove its completed snapshot'); });
 } };
}
