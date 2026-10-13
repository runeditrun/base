// Read an npm tarball for installing: check it is exactly the registry's bytes
// (sha512 integrity, and the entry count and unpacked size when the registry
// gives them) and that every entry is a plain file or folder under package/,
// then write it out. Absolute paths, .. entries, links and devices are refused,
// and so is anything another tar reader could read differently: a format other
// than ustar, a pax extended header with a field other than path, size or
// mtime, or data after the end of the archive. install.sh checks the same way.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { UpdateFailure } from './registry.mjs';

const text = (block, start, length) => { const end = block.subarray(start, start + length).indexOf(0); return block.toString('utf8', start, end === -1 ? start + length : start + end); };

// A pax extended header's records ("<length> <key>=<value>\n"): path and size
// replace the next entry's own, mtime is only a time; any other field is refused.
function paxFields(data) {
 const fields = {};
 for (let offset = 0; offset < data.length;) {
  const space = data.indexOf(0x20, offset), digits = data.toString('latin1', offset, space), length = Number(digits);
  if (space === -1 || !/^[1-9]\d*$/.test(digits) || offset + length <= space + 1 || offset + length > data.length || data[offset + length - 1] !== 0x0a) throw new UpdateFailure('The archive has a damaged extended header.');
  const record = data.toString('utf8', space + 1, offset + length - 1), equals = record.indexOf('=');
  const key = record.slice(0, equals), value = record.slice(equals + 1);
  offset += length;
  if (equals < 1) throw new UpdateFailure('The archive has a damaged extended header.');
  if (key === 'linkpath') throw new UpdateFailure('The archive contains a link.');
  if (key === 'size' && !/^\d+$/.test(value)) throw new UpdateFailure('The archive has a damaged extended header.');
  if (key !== 'path' && key !== 'size' && key !== 'mtime') throw new UpdateFailure(`The archive has an extended header field rer does not read (${key}).`);
  fields[key] = key === 'size' ? Number(value) : value;
 }
 return fields;
}

// Every entry under package/, folders included (each counts toward the
// registry's dist.fileCount); a folder has empty data.
export function readPackage(bytes, dist) {
 if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(dist.integrity ?? '')) throw new UpdateFailure('The registry gives no sha512 integrity for this version.');
 if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== dist.integrity) throw new UpdateFailure('The download does not match the registry\'s sha512 integrity.');
 let tar;
 try { tar = gunzipSync(bytes); } catch { throw new UpdateFailure('The download is not a gzip archive.'); }
 const entries = [];
 let offset = 0, pax, ended = false;
 while (offset + 512 <= tar.length) {
  const block = tar.subarray(offset, offset + 512);
  if (block.every(byte => byte === 0)) {
   if (!tar.subarray(offset).every(byte => byte === 0)) throw new UpdateFailure('The archive has data after its end.');
   ended = true;
   break;
  }
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (parseInt(text(block, 148, 8), 8) !== sum) throw new UpdateFailure('The archive has a damaged header.');
  if (block.toString('latin1', 257, 265) !== 'ustar\u0000' + '00') throw new UpdateFailure('The archive is not a ustar archive.');
  const sizeField = text(block, 124, 12).trim();
  if (!/^[0-7]+$/.test(sizeField)) throw new UpdateFailure('The archive has a damaged header.');
  const type = String.fromCharCode(block[156] || 48), size = type !== 'x' && pax?.size !== undefined ? pax.size : parseInt(sizeField, 8);
  const data = tar.subarray(offset + 512, offset + 512 + size);
  if (data.length < size) throw new UpdateFailure('The archive is truncated.');
  offset += 512 + Math.ceil(size / 512) * 512;
  if (type === 'x') {
   if (pax) throw new UpdateFailure('The archive has two extended headers for one entry.');
   pax = paxFields(data);
   continue;
  }
  const name = pax?.path ?? (text(block, 345, 155) ? `${text(block, 345, 155)}/${text(block, 0, 100)}` : text(block, 0, 100));
  pax = undefined;
  if (type !== '0' && type !== '5') throw new UpdateFailure(`The archive contains a link, device or other special entry (${name}).`);
  const parts = name.split('/');
  if (name.startsWith('/') || parts.includes('..') || name.includes('\\') || parts[0] !== 'package') throw new UpdateFailure(`The archive contains an unsafe path (${name}).`);
  if (type === '5' && size !== 0) throw new UpdateFailure(`The archive gives the folder ${name} contents.`);
  if (type === '0' && name.endsWith('/')) throw new UpdateFailure(`The archive gives the file ${name} a folder's name.`);
  entries.push({ path: parts.slice(1).filter(Boolean).join('/'), data, executable: (parseInt(text(block, 100, 8), 8) & 0o100) !== 0, directory: type === '5' });
 }
 if (!ended || pax) throw new UpdateFailure('The archive is truncated.');
 if (dist.fileCount !== undefined && dist.fileCount !== entries.length) throw new UpdateFailure(`The archive holds ${entries.length} entries; the registry says ${dist.fileCount}.`);
 const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
 if (dist.unpackedSize !== undefined && dist.unpackedSize !== total) throw new UpdateFailure(`The archive unpacks to ${total} bytes; the registry says ${dist.unpackedSize}.`);
 return entries;
}

export async function writePackage(entries, root) {
 for (const entry of entries) {
  if (entry.directory) { await mkdir(join(root, entry.path), { recursive: true }); continue; }
  await mkdir(dirname(join(root, entry.path)), { recursive: true });
  try { await writeFile(join(root, entry.path), entry.data, { mode: entry.executable ? 0o755 : 0o644, flag: 'wx' }); }
  catch (error) { if (['EEXIST', 'EISDIR'].includes(error.code)) throw new UpdateFailure(`The archive holds ${entry.path} twice.`); throw error; }
 }
}
