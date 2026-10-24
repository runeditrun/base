import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { failure } from './error.mjs';

export function validBackupName(name) {
 if (typeof name !== 'string' || !/^[0-9]{8}T[0-9]{9}Z-[1-9][0-9]{0,9}$/.test(name)) return false;
 const [stamp, pid] = name.split('-');
 if (Number(pid) > 2147483647) return false;
 const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
 const date = new Date(iso);
 return Number.isFinite(date.getTime()) && date.toISOString() === iso;
}

// null records original absence. A present component records every directory
// and every file's bytes, so a lost child cannot become an absent component.
export async function stateManifest(root) {
 const entries = [];
 async function visit(path, relative) {
  const status = await lstat(path);
  if (status.isSymbolicLink() || process.getuid && status.uid !== process.getuid() ||
   !status.isDirectory() && (!status.isFile() || status.nlink !== 1)) throw failure('refused');
  if (status.isDirectory()) {
   entries.push({ path: relative, type: 'directory' });
   for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name);
  } else {
   const hash = createHash('sha256');
   for await (const bytes of createReadStream(path)) hash.update(bytes);
   entries.push({ path: relative, type: 'file', sha256: hash.digest('hex') });
  }
 }
 try { await lstat(root); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
 await visit(root, '');
 return entries;
}
