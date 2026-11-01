// The immediate checkout folders shown by rer list. No recursive disk search.
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkoutFolders(directory) {
 const folders = [];
 for (const item of await readdir(directory, { withFileTypes: true })) {
  const path = join(directory, item.name);
  try {
   if ((await stat(path)).isDirectory() && (await stat(join(path, 'OPERATIONS.json'))).isFile()) folders.push(await realpath(path));
  } catch { /* Not a readable checkout, as in rer list. */ }
 }
 return [...new Set(folders)];
}
