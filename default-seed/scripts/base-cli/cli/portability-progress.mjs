import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Bytes under a directory, for the first progress line's estimate. Missing or vanishing files count as zero.
export async function stateBytes(directory) {
 let total = 0;
 for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
  const path = join(directory, entry.name);
  total += entry.isDirectory() ? await stateBytes(path) : (await lstat(path).catch(() => ({ size: 0 }))).size;
 }
 return total;
}

// The class and code of an unexpected failure, when each is a plain identifier. Its message can hold row data.
export function nativeFailure(error) {
 const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'unknown';
 const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : Number.isSafeInteger(error?.code) ? String(error.code) : undefined;
 return { class: name, ...(code ? { code } : {}) };
}
