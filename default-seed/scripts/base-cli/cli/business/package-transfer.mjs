import { constants } from 'node:fs';
import { open, mkdir, chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CHUNK = 65_536, MAX_BYTES = 32 * 1024 ** 3;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/.test(value);
const pathValid = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..');
async function durableJson(path, value) {
 const temporary = path + '.' + randomUUID() + '.tmp';
 const file = await open(temporary, 'wx', 0o600);
 try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
 try { await rename(temporary, path); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Concatenated index and exact source files; no JSON reserialization of the package files. */
export async function buildPackage({ files, source, mode = 'snapshot', records, totals, quota, directory, signal }) {
 if (!Number.isSafeInteger(quota) || quota < CHUNK || quota > 2 * 1024 ** 2) throw Error('Unsupported package grant byte quota.');
 if (!Array.isArray(files) || !files.length || files.length > 100_000) throw Error('Invalid package files.');
 let offset = 0; const names = new Set();
 const entries = files.map(file => {
  if (!pathValid(file.path) || file.path === 'index.ndjson' || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid package file.');
  names.add(file.path);
  const entry = { path: file.path, bytes: file.bytes, sha256: file.sha256, offset };
  offset += file.bytes;
  if (!Number.isSafeInteger(offset) || offset > MAX_BYTES) throw Error('Package byte limit.');
  return entry;
 });
 const index = Buffer.from(entries.map(row => JSON.stringify(row) + '\n').join(''));
 if (index.length > quota || index.length + offset > MAX_BYTES) throw Error('Package index or stream byte limit.');
 await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
 const segments = [], streamHash = createHash('sha256'); let pending = Buffer.alloc(0), bytes = 0;
 const save = async value => {
  const ordinal = segments.length, path = join(directory, `segment-${ordinal}`), temporary = path + '.tmp';
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); segments.push({ bytes: value.length, sha256: hash(value), file: path });
 };
 const feed = async value => {
  signal?.throwIfAborted(); streamHash.update(value); bytes += value.length;
  let position = 0;
  while (position < value.length) {
   const length = Math.min(quota - pending.length, value.length - position);
   pending = Buffer.concat([pending, value.subarray(position, position + length)]); position += length;
   if (pending.length === quota) { await save(pending); pending = Buffer.alloc(0); }
  }
 };
 await feed(index);
 for (const file of files) {
  const handle = await open(file.file, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash('sha256'); let size = 0;
  try {
   const info = await handle.stat(); if (!info.isFile() || info.size !== file.bytes) throw Error('Package source changed before upload.');
   for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: CHUNK })) {
    size += chunk.length; if (size > file.bytes) throw Error('Package source changed before upload.');
    digest.update(chunk); await feed(chunk);
   }
   if (size !== file.bytes || digest.digest('hex') !== file.sha256) throw Error('Package source changed before upload.');
  } finally { await handle.close(); }
 }
 if (pending.length) await save(pending);
 const manifest = { format: 'rer-door-package/1', source, mode, stream: { bytes, sha256: streamHash.digest('hex') },
  segments: segments.map(({ bytes, sha256 }) => ({ bytes, sha256 })), index: { path: 'index.ndjson', bytes: index.length, sha256: hash(index) }, records, totals };
 const manifestBytes = Buffer.from(JSON.stringify(manifest));
 if (manifestBytes.length > quota) throw Error('Package manifest exceeds the grant byte quota.');
 const manifestPath = join(directory, 'rer-package.json'); await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
 return { manifest, directory, segments, manifestFile: { bytes: manifestBytes.length, sha256: hash(manifestBytes), file: manifestPath } };
}

/** Persist upload ids before their first request. Inventory is the authority after an interrupted ACK. */
export async function transferPackage({ prepared, fresh, request, signal, checkpoint, catchup = false }) {
 const { manifestFile, segments, directory } = prepared, journalPath = join(directory, 'journal.json');
 let journal;
 try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 if (!journal || journal.manifestSha256 !== manifestFile.sha256) journal = { manifestSha256: manifestFile.sha256, uploads: {}, supported: false };
 if (!journal.uploads || typeof journal.uploads !== 'object') throw Error('Invalid package journal.');
 const save = () => durableJson(journalPath, journal);
 let done = 0;
 async function upload(file, name, key) {
  let uploadId = journal.uploads[key], inventory = null;
  if (uploadId !== undefined && !id(uploadId)) throw Error('Invalid package journal upload id.');
  if (uploadId) {
   try { inventory = await request(await fresh('uploads'), { uploadId }, signal); }
   catch (error) { if (error.doorStatus !== 404) throw error; uploadId = null; }
  }
  if (!uploadId) { uploadId = randomUUID(); journal.uploads[key] = uploadId; await save(); }
  const handle = await open(file.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
   const totalChunks = Math.ceil(file.bytes / CHUNK), received = new Map();
   if (inventory) {
    if (inventory.uploadId !== uploadId || inventory.bundleSha256 !== file.sha256 || !Array.isArray(inventory.received)) throw Error('Invalid package inventory.');
    for (const row of inventory.received) {
     if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= totalChunks || received.has(row.ordinal)) throw Error('Invalid package chunk inventory.');
     received.set(row.ordinal, row);
    }
   }
   for (let index = 0; index < totalChunks; index++) {
    signal.throwIfAborted();
    const bytes = Buffer.alloc(Math.min(CHUNK, file.bytes - index * CHUNK)), { bytesRead } = await handle.read(bytes, 0, bytes.length, index * CHUNK);
    if (bytesRead !== bytes.length) throw Error('Package spool changed.');
    const row = received.get(index);
    if (row && (row.sha256 !== hash(bytes) || row.size !== bytes.length)) throw Error('Package inventory differs from local bytes.');
    if (!row) {
     const result = await request(await fresh('uploads'), { uploadId, name, bundleSha256: file.sha256, totalBytes: file.bytes, totalChunks, index, chunkSha256: hash(bytes), base64: bytes.toString('base64') }, signal);
     if (result.uploadId !== uploadId || result.bundleSha256 !== file.sha256 || index === totalChunks - 1 && result.complete !== true) throw Error('Invalid package upload answer.');
    }
    done += bytes.length;
    await checkpoint({ bytes_done: done });
   }
  } finally { await handle.close(); }
  return uploadId;
 }
 const uploadId = await upload(manifestFile, 'rer-package.json', 'manifest');
 let preview;
 try { preview = await request(await fresh('plan'), { uploadId, ...(catchup ? { catchup: true } : {}) }, signal); }
 catch (error) {
  if (error.doorStatus !== 409 || error.doorCode !== 'package_segment_missing' || !Array.isArray(error.doorDetails?.missing) || !error.doorDetails.missing.length
   || error.doorDetails.missing.some(row => !segments.some(s => s.sha256 === row.sha256 && s.bytes === row.bytes))) {
   throw Object.assign(Error('SEED_PACKAGE_UNSUPPORTED: the seed did not accept a manifest-first package probe. No segments were sent.'), { cause: error });
  }
  journal.supported = true; await save();
 }
 if (preview && !journal.supported) throw Error('SEED_PACKAGE_UNSUPPORTED: the seed did not request package segments. No segments were sent.');
 if (!preview) for (let index = 0; index < segments.length; index++) await upload(segments[index], 'rer-segment', String(index));
 return { uploadId, bundle: { size: manifestFile.bytes, sha256: manifestFile.sha256 }, ...(preview ? { preview } : {}) };
}
