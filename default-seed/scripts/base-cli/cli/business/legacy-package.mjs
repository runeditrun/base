import { constants } from 'node:fs';
import { open, readFile, realpath, mkdir, chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertChunk } from './outbound.mjs';
import { stateDirectory } from './state.mjs';

export const LEGACY_FORMAT = 'happytohelp-legacy-chunks-v1';
const MAX_BYTES = 32 * 1024 ** 3, MAX_JSON = 32 * 1024 ** 2, MAX_FILES = 100_000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const count = n => Number.isSafeInteger(n) && n >= 0;
const registrationPath = () => join(stateDirectory(), 'legacy-package.json');
const refused = (file, row, reason) => { throw Error(`Legacy package refused: ${file}, row ${row}: ${reason}. Use HappyToHelp's repass, then register the package again.`); };
const filename = name => typeof name === 'string' && /^\w[\w.-]*$/.test(name) && name !== 'index.ndjson' && name !== 'rer-package.json';

/** Every opened source is a regular file, never a symlink; hashing is streamed. */
async function inspect(root, name, expected, json = false) {
 if (!filename(name)) refused('manifest.json', 1, 'invalid filename');
 let file;
 try { file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
 catch { refused(name, 0, 'file unavailable'); }
 try {
  const info = await file.stat();
  if (!info.isFile() || !count(expected.bytes) || info.size !== expected.bytes || info.size > (json ? MAX_JSON : MAX_BYTES)) refused(name, 0, 'size mismatch or limit');
  const hash = createHash('sha256'), chunks = [];
  for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); if (json) chunks.push(chunk); }
  if (!/^[a-f0-9]{64}$/.test(expected.sha256 ?? '') || hash.digest('hex') !== expected.sha256) refused(name, 0, 'SHA-256 mismatch');
  if (!json) return;
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { refused(name, 1, 'invalid JSON'); }
  const rows = Array.isArray(value) ? value : [value];
  // Check decoded strings as well as raw JSON, so escaping cannot hide a token.
  const detect = value => {
   if (typeof value === 'string') assertChunk(Buffer.from(value), []);
   else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assertChunk(Buffer.from(key), []); detect(child); }
  };
  for (let i = 0; i < rows.length; i++) {
   try { assertChunk(Buffer.from(JSON.stringify(rows[i])), []); detect(rows[i]); } catch { refused(name, i + 1, 'outbound detector'); }
  }
  return value;
 } finally { await file.close(); }
}

/** Validate the complete legacy database package before any upload. Media are customer originals. */
export async function verifyLegacyPackage(directory) {
 const path = await realpath(resolve(directory));
 let manifestBytes;
 const handle = await open(join(path, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
 try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_JSON) refused('manifest.json', 1, 'manifest size'); manifestBytes = await handle.readFile(); }
 finally { await handle.close(); }
 let manifest;
 try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch { refused('manifest.json', 1, 'invalid JSON'); }
 if (manifest?.format !== LEGACY_FORMAT || !Array.isArray(manifest.chunks) || !Array.isArray(manifest.context) || !Array.isArray(manifest.objects)
  || !manifest.source?.rowCounts || typeof manifest.source.rowCounts !== 'object' || Array.isArray(manifest.source.rowCounts)
  || !Array.isArray(manifest.source.attachments) || manifest.attachmentsComplete !== true) refused('manifest.json', 1, 'invalid legacy manifest');
 await inspect(path, 'manifest.json', { bytes: manifestBytes.length, sha256: sha(manifestBytes) }, true);
 const files = [{ path: 'manifest.json', file: join(path, 'manifest.json'), bytes: manifestBytes.length, sha256: sha(manifestBytes) }], seen = new Set(['manifest.json']), rowCounts = {};
 const add = (name, bytes, sha256) => {
  if (!filename(name) || seen.has(name) || files.length >= MAX_FILES) refused('manifest.json', 1, 'duplicate filename or file limit');
  if (!count(bytes) || files.reduce((n, f) => n + f.bytes, 0) + bytes > MAX_BYTES) refused(name, 0, 'package byte limit');
  seen.add(name); files.push({ path: name, file: join(path, name), bytes, sha256 });
 };
 for (const [name, n] of Object.entries(manifest.source.rowCounts)) if (!name || !count(n)) refused('manifest.json', 1, 'invalid row counts');
 for (const [parts, primary] of [[manifest.chunks, true], [manifest.context, false]]) for (const part of parts) {
  if (!part || typeof part.table !== 'string' || !Object.hasOwn(manifest.source.rowCounts, part.table) || !count(part.count)) refused('manifest.json', 1, 'invalid chunk count or table');
  add(part.file, part.bytes, part.sha256);
  const rows = await inspect(path, part.file, part, true);
  if (!Array.isArray(rows) || rows.length !== part.count) refused(part.file, 0, 'row count mismatch');
  if (primary) Object.defineProperty(rowCounts, part.table, { value: (Object.hasOwn(rowCounts, part.table) ? rowCounts[part.table] : 0) + rows.length, enumerable: true, configurable: true });
 }
 for (const [table, n] of Object.entries(manifest.source.rowCounts)) if ((Object.hasOwn(rowCounts, table) ? rowCounts[table] : 0) !== n) refused('manifest.json', 1, 'table count mismatch');
 const keys = new Set(), media = new Set(); let objectBytes = 0;
 for (const object of manifest.objects) {
  if (!object || typeof object.key !== 'string' || !object.key.startsWith('legacy/') || object.key.split('/').includes('..') || object.mediaId == null
   || keys.has(object.key) || media.has(String(object.mediaId)) || !count(object.size)) refused('manifest.json', 1, 'invalid object identity');
  keys.add(object.key); media.add(String(object.mediaId));
  add(object.file, object.size, object.sha256);
  await inspect(path, object.file, { bytes: object.size, sha256: object.sha256 });
  objectBytes += object.size;
 }
 const attachments = manifest.source.attachments;
 if (attachments.length !== manifest.objects.length || new Set(attachments.map(e => e?.key)).size !== attachments.length
  || attachments.some(e => !manifest.objects.some(o => o.key === e?.key && String(o.mediaId) === String(e.mediaId)))) refused('manifest.json', 1, 'attachment count or identity mismatch');
 const bytes = files.reduce((n, f) => n + f.bytes, 0);
 if (!count(bytes) || bytes > MAX_BYTES) refused('manifest.json', 1, 'package byte limit');
 return { path, manifestSha256: sha(manifestBytes), bytes, rowCounts: { ...manifest.source.rowCounts }, objects: { count: manifest.objects.length, bytes: objectBytes }, files, manifest };
}

export async function loadLegacyRegistration() {
 try { return JSON.parse(await readFile(registrationPath(), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function registeredLegacyPackage() {
 const saved = await loadLegacyRegistration();
 if (!saved) throw Error('No legacy package is registered. Run rer business legacy-package add DIR.');
 let current;
 try { current = await verifyLegacyPackage(saved.path); } catch { throw Error(`Legacy package changed or is unavailable: ${saved.path}. Use HappyToHelp's repass and register it again.`); }
 if (JSON.stringify(summary(current)) !== JSON.stringify(saved)) throw Error(`Legacy package changed: ${saved.path}. Register the package again.`);
 return current;
}
const summary = ({ path, manifestSha256, bytes, rowCounts, objects }) => ({ path, manifestSha256, bytes, rowCounts, objects });
export async function legacyPackage(action, directory) {
 if (!['add', 'remove', 'status'].includes(action)) throw Error('Usage: rer business legacy-package add|remove|status DIR');
 if (action === 'add') {
  const verified = await verifyLegacyPackage(directory), target = registrationPath();
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 }); await chmod(stateDirectory(), 0o700);
  const temporary = target + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(summary(verified)), { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
 }
 const saved = await loadLegacyRegistration();
 if (saved && saved.path !== await realpath(resolve(directory))) throw Error('That directory is not the registered legacy package.');
 if (action === 'remove') await unlink(registrationPath()).catch(error => { if (error.code !== 'ENOENT') throw error; });
 const result = action === 'remove' ? null : saved;
 // Registration never prints paths or customer rows; a changed task names its package locally.
 process.stdout.write(JSON.stringify(result ? { bytes: result.bytes, rowCounts: result.rowCounts, objects: result.objects, manifestSha256: result.manifestSha256 } : { registered: false }) + '\n');
}

