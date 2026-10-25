// Check the complete write plan, independently of the host filesystem's spelling
// rules. A refresh must remain portable to case-insensitive, normalizing disks.
import fs from 'node:fs';
import path from 'node:path';
import {safe, noLinks} from './files.mjs';

// Include case expansions (such as sharp s) and canonical Unicode equivalence.
const portable = name => name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

export function checkCopyDestinations({root, plans, files, recordPath}) {
  const destinations = new Map(), writes = [];
  const conflict = (a, b) => {
    throw Error(`Conflicting Base copy destinations: ${a.name} (${a.source}) and ${b.name} (${b.source}); no files were changed. Reconcile the copy mappings before refreshing.`);
  };
  for (const {copy, sources} of plans) {
    for (const [source] of sources) writes.push({name: copy.path + source.slice(copy.originPath.length), source});
    for (const name of Object.keys(copy.adapted || {})) writes.push({name, source: copy.originPath + name.slice(copy.path.length)});
  }
  // The record is also a write target, never a source destination.
  writes.push({name: recordPath, source: 'Base copy record'});
  for (const item of writes) {
    safe(item.name);
    const key = portable(item.name), previous = destinations.get(key);
    if (previous) conflict(previous, item);
    destinations.set(key, {...item, planned: true});
  }
  const removed = new Set(plans.flatMap(plan => plan.removed));
  for (const name of files.keys()) {
    if (removed.has(name)) continue;
    const item = {name, source: 'existing seed file'}, key = portable(name), planned = destinations.get(key);
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
  // Perform every filesystem-shape check before the writer can change anything.
  for (const {name} of writes) {
    noLinks(root, name);
    const target = path.join(root, name);
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw Error(`Base copy destination is not a regular file: ${name}; no files were changed.`);
  }
  for (const name of removed) noLinks(root, name);
}
