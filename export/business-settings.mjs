import { cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { testSource } from '../composition/git-source.mjs';

// The app's runtime copy and its Node-only signer have separate destinations.
export async function exportBusinessSettings(base, target) {
 const source = resolve(base, 'modules/business-settings');
 const runtime = resolve(target, 'src/modules/business-settings');
 const testing = resolve(target, 'tests/business-settings');
 const sources = {};
 await cp(source, runtime, { recursive: true, filter: path => {
  const name = relative(source, path);
  return name.split('/')[0] !== 'testing' && !testSource(name)
   && !['node_modules', '.cache', '.state'].includes(basename(path));
 } });
 await cp(resolve(source, 'testing'), testing, { recursive: true });
 async function record(directory, original) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
   const file = resolve(directory, entry.name), canonical = resolve(original, entry.name);
   if (entry.isDirectory()) { await record(file, canonical); continue; }
   let bytes = await readFile(file), transformation;
   if (canonical === resolve(source, 'index.ts')) {
    const relocated = bytes.toString('utf8').replaceAll('../../foundation/runtime/', '../../base/');
    if (relocated !== bytes.toString('utf8')) {
     bytes = Buffer.from(relocated); await writeFile(file, bytes);
     transformation = 'Contained runtime import relocation';
    }
   }
   sources[relative(target, file)] = { source: relative(base, canonical),
    sha256: createHash('sha256').update(bytes).digest('hex'), ...(transformation ? { transformation } : {}) };
  }
 }
 await record(runtime, source);
 await record(testing, resolve(source, 'testing'));
 return { sources, maps: {
  [resolve(source, 'testing')]: testing,
  [source]: runtime,
 } };
}
