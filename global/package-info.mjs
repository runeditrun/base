// Facts about the running rer package: where it lives, its version and the
// digest of its contents (which tells two builds of one version apart).
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageName = '@runeditrun/rer';
export const ownRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

export function ownManifest() {
 const packed = JSON.parse(readFileSync(join(ownRoot, 'package.json'), 'utf8'));
 return packed.name === packageName ? packed : JSON.parse(readFileSync(join(ownRoot, 'global/package.json'), 'utf8'));
}

export async function packageFileList(root) {
 const files = [];
 async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
   const path = join(directory, entry.name);
   if (entry.isDirectory()) await walk(path);
   else if (entry.isFile()) files.push(relative(root, path));
   else throw Error(`Unexpected non-file entry in the rer package: ${relative(root, path)}`);
  }
 }
 await walk(root);
 return files.sort();
}

// sha256 over every file's path and bytes, in a fixed order.
export async function packageDigest(root) {
 const hash = createHash('sha256');
 for (const path of await packageFileList(root)) {
  hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0');
 }
 return hash.digest('hex');
}
