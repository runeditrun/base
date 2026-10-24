// Plan the relative module closure before refresh writes any seed files.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {safe, noLinks} from './files.mjs';
import {staticImports} from './static-imports.mjs';

const within = (name, directory) => directory === '.' || name.startsWith(directory + '/');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const javascript = name => /\.(?:mjs|cjs|js)$/.test(name);

export function closeImports({root, record, recordPath, plans, next, read, revision, local, files}) {
  const adopted = [], problems = new Set(), queue = [], scheduled = new Map();
  const locate = name => plans.find(({copy}) => Object.hasOwn(copy.files, name) || copy.path === name || name.startsWith(copy.path + '/'));
  const enqueue = (plan, source, name, bytes, boundary, depth, adapted = false, pin = plan.copy.revision) => {
    const previous = scheduled.get(name);
    if (previous && previous.source !== source) throw Error(`Conflicting Base import mappings for ${name}`);
    if (previous) return;
    scheduled.set(name, {source, plan});
    if (javascript(source)) queue.push({plan, source, name, bytes, boundary, depth, adapted, pin});
  };
  const initial = plans.flatMap(plan => plan.sources.map(([source, entry]) => ({plan, source, entry})));
  const bytes = read.blobs(initial.map(({entry}) => entry.object));
  for (const {plan, source, entry} of initial) {
    const singleton = Object.hasOwn(plan.copy.files, plan.copy.path);
    enqueue(plan, source, plan.copy.path + source.slice(plan.copy.originPath.length), bytes.get(entry.object), singleton ? path.posix.dirname(source) : plan.copy.originPath, 0);
  }
  for (const plan of plans) for (const name of Object.keys(plan.copy.adapted || {})) {
    const source = plan.copy.originPath + name.slice(plan.copy.path.length);
    enqueue(plan, source, name, files.get(name).read(), Object.hasOwn(plan.copy.files, plan.copy.path) ? path.posix.dirname(source) : plan.copy.originPath, 0, true);
  }
  for (let i = 0; i < queue.length; i++) {
    const importer = queue[i];
    let specifiers;
    try { specifiers = staticImports(importer.bytes.toString('utf8')).filter(value => value.startsWith('./') || value.startsWith('../')); }
    catch (error) { problems.add(`${importer.name}: cannot establish its static imports (${error.message}); refresh will not guess. Simplify the construct in Base, or adopt the edition with rer adopt-edition.`); continue; }
    for (const specifier of specifiers) {
      let source, name;
      try {
        source = path.posix.relative('/repository', fileURLToPath(new URL(specifier, pathToFileURL('/repository/' + importer.source))));
        name = path.posix.relative('/repository', fileURLToPath(new URL(specifier, pathToFileURL('/repository/' + importer.name))));
        safe(source); safe(name);
      } catch { throw Error(`Cannot resolve relative Base import ${specifier} in ${importer.name}; no files were changed.`); }
      const fail = reason => problems.add(`${importer.name} imports ${specifier}: ${reason} (${source}). Review and materialize the dependency, then run record-base ${quote(name)} ${quote(source)} ${revision}${recordPath === 'base-copies.json' ? '' : ' --record ' + quote(recordPath)}.`);
      const existing = scheduled.get(name);
      if (existing) {
        if (existing.source !== source) fail('recorded with a different Base origin');
        continue;
      }
      if (!within(source, importer.boundary)) { fail('outside the copied origin directory'); continue; }
      const entry = next.get(source), owner = locate(name);
      if (!entry) { fail('no regular Base file at the target revision'); continue; }
      if (owner && Object.hasOwn(owner.copy.files, name)) { fail('recorded file was removed or kept out; it will not be restored'); continue; }
      if (importer.adapted) { fail('seed-owned importer needs explicit dependency reconciliation'); continue; }
      if (importer.depth >= 64) { fail('relative import closure exceeds 64 levels'); continue; }
      // A file excluded at the pin, deleted locally, ignored, or owned by the
      // seed is never silently adopted, even if a new importer requires it.
      const pinned = read.tree(owner ? owner.copy.revision : importer.pin);
      if (pinned.has(source) && !local(name)) { fail('file was kept out at the copy pin'); continue; }
      if ((record.ignore || []).some(prefix => name === prefix || name.startsWith(prefix + '/'))) { fail('file is explicitly ignored'); continue; }
      noLinks(root, name);
      if (fs.existsSync(path.join(root, name)) && !files.get(name)?.regular) { fail('destination is not a regular seed file'); continue; }
      const content = read.blobs([entry.object]).get(entry.object);
      if (fs.existsSync(path.join(root, name)) && !local(name)) { fail('destination is outside the seed file inventory'); continue; }
      if (local(name) && local(name) !== read.digests([entry.object]).get(entry.object)) { fail('destination contains seed-owned bytes'); continue; }
      let plan = owner;
      if (plan) {
        if (plan.retired || plan.copy.originPath + name.slice(plan.copy.path.length) !== source) { fail('destination belongs to a different copy'); continue; }
        plan.sources.push([source, entry]);
        plan.removed = plan.removed.filter(removed => removed !== name);
      } else {
        // Singleton records cannot contain siblings; preserve the existing
        // schema and mapping by recording each adopted helper as a singleton.
        plan = {copy: {path: name, originPath: source, revision, files: {}}, sources: [[source, entry]], removed: []};
        plans.push(plan);
      }
      adopted.push({path: name, originPath: source});
      enqueue(plan, source, name, content, importer.boundary, importer.depth + 1, false, importer.pin);
    }
  }
  if (problems.size) throw Error(`Unresolvable relative Base imports; no files were changed:\n${[...problems].sort().join('\n')}`);
  return adopted.sort((a, b) => a.path.localeCompare(b.path));
}
