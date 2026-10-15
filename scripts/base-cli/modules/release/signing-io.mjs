import { constants, lstatSync, openSync, closeSync, readSync, writeFileSync, fstatSync } from 'node:fs';
import { resolve, dirname, parse } from 'node:path';
import { Refusal } from './signature.mjs';

export const SIGNATURE_FILE = 'rer-release.dsse.json';
export const FILE_LIMIT = 1024 ** 3;
export function refuse(code) { throw new Refusal(code); }

// Check every parent too: O_NOFOLLOW alone only protects the final component.
export function safePath(path, { missing = false } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = resolve(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' && missing && current === absolute) return absolute;
      refuse('FILE_MISSING');
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (current !== absolute && !stat.isDirectory())) refuse('PATH_UNSAFE');
  }
  return absolute;
}

export function readBounded(path, limit = FILE_LIMIT) {
  const absolute = safePath(path);
  let fd;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile()) refuse('PATH_UNSAFE');
    if (before.size > limit) refuse('INPUT_TOO_LARGE');
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) refuse('PATH_UNSAFE');
    if (stat.size > limit) refuse('INPUT_TOO_LARGE');
    // A bounded read also prevents a concurrently growing file from exhausting memory.
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) refuse('DIGEST_MISMATCH');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) refuse('DIGEST_MISMATCH');
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function writeNew(path, bytes) {
  safePath(dirname(resolve(path)));
  safePath(path, { missing: true });
  // Exclusive creation never replaces another receipt, key entry or symlink.
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch { refuse('PATH_UNSAFE'); }
}

export function parseJSON(bytes, code = 'STATEMENT_INVALID') {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { refuse(code); }
}
