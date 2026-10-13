import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vendoredPaths } from '../../cli/package-mode.mjs';
import { copyChecks } from './copy-checks.mjs';

// Match the removed tree itself and its descendants, never a neighbouring
// folder or an origin record describing where retained app source came from.
const removed = path => typeof path === 'string' && [...vendoredPaths, ...copyChecks].some(folder =>
 path.replace(/^\.\//, '') === folder || path.replace(/^\.\//, '').startsWith(folder + '/'));

function edition(value) {
 const dropped = new Set();
 value.components = value.components?.filter(component => {
  const source = component.source;
  if (source?.kind === 'local') {
   source.paths = source.paths.filter(path => !removed(path));
   if (source.mappings) source.mappings = source.mappings.filter(mapping => !removed(mapping.path));
   if (source.paths.length) return true;
  } else if (!removed(source?.destination)) return true;
  dropped.add(component.id); return false;
 });
 for (const component of value.components ?? []) for (const key of ['requires', 'conflicts']) {
  if (component[key]) component[key] = component[key].filter(id => !dropped.has(id));
 }
}

// Delivery declarations hold path/glob arrays in verification and packaging
// sections. Only array entries rooted in a removed tree are discarded.
function globs(value) {
 if (Array.isArray(value)) return value.filter(item => !removed(item)).map(globs);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, globs(item)]));
 return value;
}

export async function planMetadata(root, json, changes = new Map()) {
 for (const file of ['edition.json', 'rer-project.json', 'packaging.json', 'scripts/delivery/base/packaging.json']) {
  const original = await readFile(join(root, file), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (original === undefined) continue;
  const value = JSON.parse(changes.get(file) ?? original);
  if (file === 'edition.json') edition(value);
  const after = json(file === 'edition.json' ? value : globs(value), original);
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(JSON.parse(after))) changes.set(file, after);
 }
 return changes;
}
