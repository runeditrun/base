// A reproducible npm tarball: ustar entries in sorted path order, every entry
// owned by 0:0 with no user or group names, mode 0644 (0755 when executable),
// the given time as every mtime, compressed by deflate.mjs (no time in the gzip
// header, the same bytes on every platform). The same files and time always
// give the same bytes.
import { gunzipSync } from 'node:zlib';
import { gzip } from './deflate.mjs';

const BLOCK = 512;

function field(header, offset, length, value) {
 const bytes = Buffer.from(value, 'utf8');
 if (bytes.length > length) throw Error(`Tar field too long: ${value}`);
 bytes.copy(header, offset);
}

const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';

// ustar keeps 100 bytes of name and 155 of prefix; split at a slash.
function splitPath(path) {
 if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
 for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
  const prefix = path.slice(0, index), name = path.slice(index + 1);
  if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
 }
 throw Error(`Path too long for a ustar entry: ${path}`);
}

// One 512-byte header. `type` and `linkname` exist for test fixtures that need
// an entry the installers must refuse; the package build writes files only.
export function header({ path, size, mode, mtime, type = '0', linkname = '' }) {
 const block = Buffer.alloc(BLOCK), { name, prefix } = splitPath(path);
 field(block, 0, 100, name);
 field(block, 100, 8, octal(mode, 8));
 field(block, 108, 8, octal(0, 8));
 field(block, 116, 8, octal(0, 8));
 field(block, 124, 12, octal(size, 12));
 field(block, 136, 12, octal(mtime, 12));
 field(block, 148, 8, ' '.repeat(8));
 field(block, 156, 1, type);
 field(block, 157, 100, linkname);
 field(block, 257, 6, 'ustar\0');
 field(block, 263, 2, '00');
 field(block, 345, 155, prefix);
 let sum = 0;
 for (const byte of block) sum += byte;
 field(block, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
 return block;
}

const padding = size => Buffer.alloc((BLOCK - size % BLOCK) % BLOCK);

// entries: [{ path, data: Buffer, executable }]; mtime in seconds.
export function tarball(entries, mtime) {
 const parts = [];
 for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
  parts.push(header({ path: entry.path, size: entry.data.length, mode: entry.executable ? 0o755 : 0o644, mtime, type: entry.type, linkname: entry.linkname }), entry.data, padding(entry.data.length));
 }
 parts.push(Buffer.alloc(BLOCK * 2));
 return compress(Buffer.concat(parts));
}

function compress(tar) {
 const compressed = gzip(tar);
 if (!gunzipSync(compressed).equals(tar)) throw Error('The package compressor produced an archive that does not unpack to its input.');
 return compressed;
}
