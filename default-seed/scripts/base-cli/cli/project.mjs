import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { containedInput } from '../modules/demo/input-path.mjs';
import { readOperations } from '../operations/operations.mjs';
import { invalid, missing, refuse } from './errors.mjs';

export function contained(root, path, options = {}) {
 return containedInput(root, path, { ...options, refuse, missing });
}

export async function resolveProject(root) {
 root = await realpath(root);
 let loaded;
 try { loaded = await readOperations(root); } catch (error) {
  if (error.code === 'ENOENT') throw missing('OPERATIONS.json or a declared input is missing. See the project operating documentation.');
  throw invalid('Malformed operations descriptor or unsafe input. Correct OPERATIONS.json and its contained inputs.');
 }
 const marker = loaded.descriptor.seedContract;
 let adapter;
 if (marker) {
  await contained(root, marker.adapter);
  try { adapter = (await import(pathToFileURL(resolve(root, marker.adapter)))).commandAdapter; }
  catch { throw invalid('The declared adapter could not be loaded. Restore its portable sources.'); }
 }
 return { root, ...loaded, profile: marker ? 'first-party' : 'independent', adapter };
}

// Only the descriptor marker distinguishes package forwarding from a raw
// independent tail. Schema validation and adapter imports happen after parsing.
export async function parsingProfile(root) {
 try { const descriptor=JSON.parse(await readFile(resolve(root,'OPERATIONS.json'),'utf8'));return descriptor.version===2&&!descriptor.seedContract?'independent':'first-party'; }
 catch { return 'first-party'; } // Help still works with absent/broken metadata.
}

export async function readPackage(root) {
 try { return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')); }
 catch { return {}; }
}
