import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { PortabilityError } from '../modules/portability/storage.mjs';

// Platform's streaming producer uses stored entries, with a data descriptor.
// Compressed entries are deliberately unsupported: no expansion is performed.
export const managedDataLimits = Object.freeze({ archiveBytes: 128 * 1024 * 1024, entryBytes: 64 * 1024 * 1024, metadataBytes: 4 * 1024 * 1024, entries: 10000 });
const check = (condition, reason) => { if (!condition) throw new PortabilityError('managed_data_' + reason, 409); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const metadata = value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(value => typeof value === 'string');
const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\\\x00-\x1f:]/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => { for (let j = 0; j < 8; j++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0); return i >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }

export async function isManagedDataZip(path) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { const bytes = Buffer.alloc(4); const { bytesRead } = await file.read(bytes, 0, 4, 0); return bytesRead >= 2 && bytes[0] === 80 && bytes[1] === 75; }
 finally { await file.close(); }
}

// Nothing is extracted to a path supplied by the archive. Both directory and
// local headers must describe the same bounded, non-overlapping members.
export async function readManagedDataZip(path) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 let bytes;
 try {
  const info = await file.stat();
  check(info.isFile() && info.size <= managedDataLimits.archiveBytes, 'oversized');
  bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); check(read.bytesRead > 0, 'truncated'); offset += read.bytesRead; }
  check((await file.stat()).size === info.size, 'truncated');
 } finally { await file.close(); }
 check(bytes.length >= 22, 'truncated');
 let end = bytes.length - 22;
 while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
 check(end >= Math.max(0, bytes.length - 65557), 'truncated');
 check(end + 22 + bytes.readUInt16LE(end + 20) === bytes.length, 'invalid_zip');
 const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
 check(!bytes.readUInt16LE(end + 4) && !bytes.readUInt16LE(end + 6) && count === bytes.readUInt16LE(end + 8), 'invalid_zip');
 check(count > 0 && count <= managedDataLimits.entries && count !== 65535, 'oversized');
 check(start + size === end, 'truncated');
 const entries = new Map(), ranges = [];
 let cursor = start, total = 0;
 const text = data => { try { return decoder.decode(data); } catch { check(false, 'invalid_utf8'); } };
 for (let i = 0; i < count; i++) {
  check(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'truncated');
  const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
  const packed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
  const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
  check(next <= end && !bytes.readUInt16LE(cursor + 34), 'truncated');
  const name = text(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
  check(safePath(name), 'unsafe_path');
  check(!entries.has(name), 'duplicate_member');
  check(method === 0 && (flags & ~0x808) === 0, 'unsupported_compression');
  check(length <= managedDataLimits.entryBytes && packed === length && (total += length) <= managedDataLimits.archiveBytes, 'oversized');
  check(offset + 30 <= start && bytes.readUInt32LE(offset) === 0x04034b50, 'truncated');
  check(bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === method, 'invalid_zip');
  const body = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28), tail = body + length;
  check(body <= start && tail <= start && text(bytes.subarray(offset + 30, offset + 30 + bytes.readUInt16LE(offset + 26))) === name, 'invalid_zip');
  let stop = tail;
  if (flags & 8) {
   check(stop + 12 <= start, 'truncated');
   if (bytes.readUInt32LE(stop) === 0x08074b50) stop += 4;
   check(stop + 12 <= start && bytes.readUInt32LE(stop) === crc && bytes.readUInt32LE(stop + 4) === packed && bytes.readUInt32LE(stop + 8) === length, 'invalid_zip');
   stop += 12;
  } else check(bytes.readUInt32LE(offset + 14) === crc && bytes.readUInt32LE(offset + 18) === packed && bytes.readUInt32LE(offset + 22) === length, 'invalid_zip');
  const data = bytes.subarray(body, tail);
  check(crc32(data) === crc, 'checksum');
  entries.set(name, data); ranges.push([offset, stop]); cursor = next;
 }
 check(cursor === end, 'invalid_zip');
 ranges.sort((a, b) => a[0] - b[0]);
 check(ranges[0][0] === 0 && ranges.every((range, i) => range[1] === (ranges[i + 1]?.[0] ?? start)), 'invalid_zip');
 const required = name => { check(safePath(name) && entries.has(name), 'missing_member'); return entries.get(name); };
 const json = name => {
  const data = required(name); check(data.length <= managedDataLimits.metadataBytes, 'oversized');
  try { return JSON.parse(text(data)); } catch (error) { if (error instanceof PortabilityError) throw error; check(false, 'invalid_manifest'); }
 };
 const manifest = json('manifest.json');
 check(manifest && typeof manifest === 'object' && manifest.kind === 'runeditrun-app-data', 'wrong_kind');
 check(manifest.schema === 1, 'unsupported_version');
 check(['installationId', 'appName', 'generatedAt'].every(key => typeof manifest[key] === 'string' && manifest[key].length > 0 && manifest[key].length <= 1024), 'invalid_manifest');
 check(Array.isArray(manifest.databases) && manifest.databases.length > 0 && Array.isArray(manifest.buckets) && Array.isArray(manifest.notIncluded), 'invalid_manifest');
 required('README.txt');
 const used = new Set(['manifest.json', 'README.txt']), bindings = new Set();
 const member = name => { check(!used.has(name), 'duplicate_member'); used.add(name); return required(name); };
 const verified = (name, size, hash) => {
  const data = member(name);
  check(Number.isSafeInteger(size) && size >= 0 && size === data.length && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'invalid_manifest');
  check(digest(data) === hash, 'checksum'); return data;
 };
 for (const database of manifest.databases) {
  check(database && typeof database.binding === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(database.binding) && !bindings.has(database.binding), 'invalid_manifest'); bindings.add(database.binding);
  const prefix = 'data/d1/' + database.binding;
  check(database.dumpPath === prefix + '.sql' && Array.isArray(database.migrationLedger), 'invalid_manifest');
  verified(database.dumpPath, database.dumpBytes, database.dumpSha256);
  member(prefix + '.json'); member(prefix + '-migrations.json');
  check(JSON.stringify(json(prefix + '.json')) === JSON.stringify(database) && JSON.stringify(json(prefix + '-migrations.json')) === JSON.stringify(database.migrationLedger), 'invalid_manifest');
 }
 for (const bucket of manifest.buckets) {
  check(bucket && typeof bucket.binding === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bucket.binding) && !bindings.has(bucket.binding) && Array.isArray(bucket.objects), 'invalid_manifest'); bindings.add(bucket.binding);
  member('data/r2/' + bucket.binding + '.json');
  check(JSON.stringify(json('data/r2/' + bucket.binding + '.json')) === JSON.stringify(bucket), 'invalid_manifest');
  const keys = new Set();
  for (const object of bucket.objects) {
   check(object && typeof object.key === 'string' && !keys.has(object.key) && safePath(object.path) && object.path.startsWith('data/r2/' + bucket.binding + '/'), 'invalid_manifest'); keys.add(object.key);
   check(metadata(object.httpMetadata) && metadata(object.customMetadata), 'invalid_manifest');
   verified(object.path, object.size, object.sha256);
  }
 }
 check(used.size === entries.size, 'unexpected_member');
 return { manifest, entries };
}
