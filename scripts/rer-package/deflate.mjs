// A gzip encoder whose output depends only on its input. Node's bundled zlib
// chooses different matches on different processors (an arm64 Mac and an x64
// Linux runner compress the same tar differently), so the package build
// compresses with this instead: greedy LZ77 over a 32 KiB window with a fixed
// hash-chain depth, written as one fixed-Huffman deflate block (RFC 1951),
// wrapped in a gzip member with no time and OS byte 3 (RFC 1952).
import { crc32 } from 'node:zlib';

const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const WINDOW = 32768, MIN_MATCH = 3, MAX_MATCH = 258, CHAIN = 128, HASH_BITS = 15;

class BitWriter {
 constructor(size) { this.bytes = Buffer.alloc(size); this.length = 0; this.buffer = 0; this.count = 0; }
 bits(value, count) {
  this.buffer |= value << this.count;
  this.count += count;
  while (this.count >= 8) { this.push(this.buffer & 0xff); this.buffer >>>= 8; this.count -= 8; }
 }
 // Huffman codes go most significant bit first.
 code(value, count) { let reversed = 0; for (let i = 0; i < count; i++) reversed |= ((value >>> i) & 1) << (count - 1 - i); this.bits(reversed, count); }
 push(byte) {
  if (this.length === this.bytes.length) { const grown = Buffer.alloc(this.bytes.length * 2); this.bytes.copy(grown); this.bytes = grown; }
  this.bytes[this.length++] = byte;
 }
 finish() { if (this.count) this.push(this.buffer & 0xff); this.buffer = 0; this.count = 0; return this.bytes.subarray(0, this.length); }
}

function literal(out, value) {
 if (value < 144) out.code(0x30 + value, 8);
 else if (value < 256) out.code(0x190 + value - 144, 9);
 else if (value < 280) out.code(value - 256, 7);
 else out.code(0xc0 + value - 280, 8);
}

function match(out, length, distance) {
 let l = lengthBase.length - 1;
 while (lengthBase[l] > length) l--;
 literal(out, 257 + l);
 if (lengthExtra[l]) out.bits(length - lengthBase[l], lengthExtra[l]);
 let d = distanceBase.length - 1;
 while (distanceBase[d] > distance) d--;
 out.code(d, 5);
 if (distanceExtra[d]) out.bits(distance - distanceBase[d], distanceExtra[d]);
}

export function deflateRaw(data) {
 const out = new BitWriter(Math.max(1024, data.length >> 1)), head = new Int32Array(1 << HASH_BITS).fill(-1), previous = new Int32Array(data.length);
 const hash = i => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & ((1 << HASH_BITS) - 1);
 const insert = i => { if (i + 2 < data.length) { const h = hash(i); previous[i] = head[h]; head[h] = i; } };
 out.bits(1, 1); // final block
 out.bits(1, 2); // fixed Huffman codes
 for (let i = 0; i < data.length;) {
  let best = 0, bestDistance = 0;
  if (i + 2 < data.length) {
   const limit = Math.min(MAX_MATCH, data.length - i);
   for (let candidate = head[hash(i)], steps = 0; candidate >= 0 && i - candidate <= WINDOW && steps < CHAIN; candidate = previous[candidate], steps++) {
    let length = 0;
    while (length < limit && data[candidate + length] === data[i + length]) length++;
    if (length > best) { best = length; bestDistance = i - candidate; if (length === limit) break; }
   }
  }
  if (best >= MIN_MATCH) {
   match(out, best, bestDistance);
   for (const end = i + best; i < end; i++) insert(i);
  } else {
   literal(out, data[i]);
   insert(i);
   i++;
  }
 }
 literal(out, 256); // end of block
 return out.finish();
}

export function gzip(data) {
 const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]), trailer = Buffer.alloc(8);
 trailer.writeUInt32LE(crc32(data), 0);
 trailer.writeUInt32LE(data.length % 2 ** 32, 4);
 return Buffer.concat([header, deflateRaw(data), trailer]);
}
