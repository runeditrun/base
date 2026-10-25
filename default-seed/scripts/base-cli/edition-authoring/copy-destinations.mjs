// Check the complete write plan, independently of the host filesystem's spelling
// rules. A refresh must remain portable to case-insensitive, normalizing disks.
import path from 'node:path';
import {safe} from './files.mjs';
import {destinationKey} from './copy-path-key.mjs';

export function checkCopyDestinations({plans, files, recordPath}) {
  const destinations = new Map(), operations = [];
  const conflict = (a, b) => {
    throw Error(`Conflicting Base copy destinations: ${a.name} (${a.source}) and ${b.name} (${b.source}); no files were changed. Reconcile the copy mappings before refreshing.`);
  };
  for (const {copy, sources} of plans) {
    for (const [source] of sources) operations.push({name: copy.path + source.slice(copy.originPath.length), source});
    for (const name of Object.keys(copy.adapted || {})) operations.push({name, source: copy.originPath + name.slice(copy.path.length)});
  }
  // Removals participate in the same exact and ancestor comparisons as writes.
  for (const {copy, removed} of plans) for (const name of removed) {
    operations.push({name, source: copy.originPath + name.slice(copy.path.length)});
  }
  // The record is also a write target, never a source destination.
  operations.push({name: recordPath, source: 'Base copy record'});
  for (const item of operations) {
    safe(item.name);
    const key = destinationKey(item.name), previous = destinations.get(key);
    if (previous) conflict(previous, item);
    destinations.set(key, {...item, planned: true});
  }
  // Directory creation is part of the plan too: distinct leaves must not
  // create two spellings of the same parent on a normalizing/caseless disk.
  const directories = new Map();
  for (const item of operations) {
    for (let parent = path.posix.dirname(item.name); parent !== '.'; parent = path.posix.dirname(parent)) {
      const key = destinationKey(parent), previous = directories.get(key);
      if (previous && previous.name !== parent) conflict(previous.item, item);
      if (!previous) directories.set(key, {name: parent, item});
    }
  }
  const removed = new Set(plans.flatMap(plan => plan.removed));
  for (const name of files.keys()) {
    if (removed.has(name)) continue;
    const item = {name, source: 'existing seed file'}, key = destinationKey(name), planned = destinations.get(key);
    if (planned?.planned && planned.name !== name) conflict(planned, item);
    if (!planned) destinations.set(key, item);
  }
  // Ancestors are checked in both directions, including seed-owned leaves.
  for (const [key, item] of destinations) {
    for (let parent = path.posix.dirname(key); parent !== '.'; parent = path.posix.dirname(parent)) {
      const ancestor = destinations.get(parent);
      if (ancestor && (ancestor.planned || item.planned)) conflict(ancestor, item);
    }
  }
}
