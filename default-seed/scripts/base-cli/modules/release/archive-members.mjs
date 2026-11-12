import { readFileSync } from 'node:fs';

// Reads member paths straight from the tar bytes. A system `tar -t` on macOS
// merges AppleDouble members while listing, so it cannot be trusted to show
// what a Linux reader will extract.
const text = bytes => bytes.toString('utf8');
const field = (block, from, to) => text(block.subarray(from, to)).replace(/\0.*$/s, '');

function octal(bytes) {
  if (bytes[0] & 0x80) {
    let value = 0n;
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
    return Number(value);
  }
  return parseInt(text(bytes).replace(/\0.*$/s, '').trim() || '0', 8);
}

function paxPath(data) {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number.parseInt(text(data.subarray(at, space)), 10);
    if (!(length > 0)) break;
    const record = text(data.subarray(space + 1, at + length - 1));
    if (record.startsWith('path=')) return record.slice(5);
    at += length;
  }
  return null;
}

export function archiveMembers(file) {
  const bytes = readFileSync(file), members = [];
  let at = 0, next = null;
  while (at + 512 <= bytes.length) {
    const block = bytes.subarray(at, at + 512);
    if (block.every(byte => byte === 0)) break;
    const type = String.fromCharCode(block[156] || 0x30);
    const size = octal(block.subarray(124, 136));
    const data = bytes.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { next = paxPath(data) ?? next; continue; }
    if (type === 'L') { next = text(data).replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    const prefix = field(block, 345, 500);
    members.push({ path: next ?? (prefix ? `${prefix}/` : '') + field(block, 0, 100), type });
    next = null;
  }
  return members;
}
