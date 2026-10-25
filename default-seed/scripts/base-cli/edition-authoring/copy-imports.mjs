// Plan the relative module closure before refresh writes any seed files.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {safe, noLinks} from './files.mjs';
import {staticImports, moduleRequests} from './static-imports.mjs';
import {moduleFormats} from './module-format.mjs';
import {copyEntrypoints} from './copy-entrypoints.mjs';

const within = (name, directory) => directory === '.' || name.startsWith(directory + '/');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
// URL schemes are case insensitive; a drive-relative path is still a drive path.
const outsidePath = value => path.posix.isAbsolute(value) || /^(?:file:|[a-z]:)/i.test(value);

export function closeImports({root, record, recordPath, plans, next, read, revision, local, files}) {
  const formatFor = moduleFormats(read, revision);
  const isCode = copyEntrypoints(read, next);
  const adopted = [], problems = new Set(), queue = [], scheduled = new Map();
  // Snapshot original ownership before closure can synthesize helper records.
  const recorded = new Map(record.copies.flatMap(copy => Object.keys(copy.files).map(name => [name, copy])));
  const unchanged = item => {
    const copy = recorded.get(item.name), file = files.get(item.name);
    if (!copy || !file?.regular || item.source !== copy.originPath + item.name.slice(copy.path.length)) return false;
    noLinks(root, item.name);
    const prior = read.tree(copy.adapted?.[item.name] || copy.revision).get(item.source);
    const target = next.get(item.source);
    if (!prior || !target || prior.object !== target.object || prior.mode !== target.mode ||
        read.digests([prior.object]).get(prior.object) !== copy.files[item.name] ||
        (copy.modes?.[item.name] && copy.modes[item.name] !== prior.mode)) return false;
    const acknowledgement = copy.acknowledged?.[item.name];
    const digest = copy.adapted?.[item.name] ? acknowledgement?.sha256 : copy.files[item.name];
    const mode = copy.adapted?.[item.name] ? acknowledgement?.mode : prior.mode;
    return local(item.name) === digest && (file.executable ? '100755' : '100644') === mode &&
      item.bytes.equals(file.read());
  };
  const locate = name => plans.find(({copy}) => Object.hasOwn(copy.files, name) || copy.path === name || name.startsWith(copy.path + '/'));
  const enqueue = (plan, source, name, bytes, boundary, depth, adapted = false, pin = plan.copy.revision, imported = false) => {
    const previous = scheduled.get(name);
    const item = previous || {plan, source, name, bytes, boundary, depth, adapted, pin};
    scheduled.set(name, item);
    // Runtime source has its own TS resolution and seed-sibling policy.
    const kind = isCode(item.source, item.bytes, imported);
    if (kind === true && !item.strict) { item.strict = true; item.queued = false; }
    if (!item.queued && !source.startsWith('foundation/runtime/') && kind !== false) {
      item.queued = true;
      queue.push(item);
    }
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
    let specifiers, format, requests;
    const failed = error => problems.add(`${importer.name}: cannot establish its static imports (${error.message}); refresh will not guess. Simplify the construct in Base, or adopt the edition with rer adopt-edition.`);
    try { format = formatFor(importer.source); }
    catch (error) { failed(error); continue; }
    try {
      requests = moduleRequests(importer.bytes, format, importer.source, true);
      specifiers = requests.specifiers.filter(value => value.startsWith('./') || value.startsWith('../') ||
        outsidePath(value));
    }
    catch (error) {
      // Tentative bytes cannot contribute imports. A later incoming edge queues
      // this same file again with strict parsing, including a prior parse error.
      if (importer.strict || !(error instanceof SyntaxError)) failed(error);
      continue;
    }
    // Literal require calls are entry signals for selected files, not static
    // closure edges. Their runtime resolution never adopts a missing target.
    for (const specifier of requests.requires.filter(value => value.startsWith('./') || value.startsWith('../'))) {
      const target = path.posix.join(path.posix.dirname(importer.name), specifier);
      const existing = scheduled.get(target);
      if (existing) enqueue(existing.plan, existing.source, target, existing.bytes, existing.boundary, existing.depth, existing.adapted, existing.pin, true);
    }
    for (const specifier of specifiers) {
      let source, name;
      const fail = reason => problems.add(`${importer.name} imports ${specifier}: ${reason} (${source ?? specifier}). Review and materialize the dependency, then run record-base ${quote(name ?? specifier)} ${quote(source ?? specifier)} ${revision}${recordPath === 'base-copies.json' ? '' : ' --record ' + quote(recordPath)}.`);
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        fail('absolute import paths are outside the seed root'); continue;
      }
      try {
        source = path.posix.relative('/repository', fileURLToPath(new URL(specifier, pathToFileURL('/repository/' + importer.source))));
        name = path.posix.relative('/repository', fileURLToPath(new URL(specifier, pathToFileURL('/repository/' + importer.name))));
        safe(source); safe(name);
      } catch { fail(`Cannot resolve relative Base import ${specifier} in ${importer.name}`); continue; }
      const existing = scheduled.get(name);
      if (isCode(source, Buffer.alloc(0), true) === false && path.posix.extname(source) !== '.json') {
        // Preserve only a verified existing edge, including its original source
        // mapping and both endpoints. New/changed unsupported edges still fail
        // before the scheduled shortcut, even inside a directory copy.
        if (!existing || !unchanged(importer) || !unchanged(existing)) {
          fail('unsupported static import format; only JavaScript and JSON are supported');
        }
        continue;
      }
      if (existing) {
        // Only mappings that existed before this refresh are authoritative.
        // A synthesized helper must satisfy every request that shares it.
        if (existing.delivered && existing.source !== source) {
          const requested = next.get(source), supplied = next.get(existing.source);
          if (!requested || requested.mode !== supplied.mode || !read.blobs([requested.object]).get(requested.object).equals(existing.bytes)) {
            fail(`conflicting planned delivery to ${name} from ${existing.source} and ${source}`); continue;
          }
        }
        // The destination's own copy mapping is authoritative. A seed may
        // compose siblings from different Base directories or adapt one of them.
        enqueue(existing.plan, existing.source, name, existing.bytes, existing.boundary, existing.depth, existing.adapted, existing.pin, true);
        continue;
      }
      const entry = next.get(source), owner = locate(name);
      if (owner && Object.hasOwn(owner.copy.files, name)) { fail('recorded file was removed or kept out; it will not be restored'); continue; }
      const outside = !within(source, importer.boundary);
      // Every Base file written by refresh, new or updated, may bring required
      // helpers across its origin boundary. Adapted/seed-owned importers cannot
      // adopt files; differing seed-owned helpers are never overwritten.
      try { noLinks(root, name); }
      catch (error) { fail(error.message); continue; }
      if (fs.existsSync(path.join(root, name)) && !files.get(name)?.regular) { fail('destination is not a regular seed file'); continue; }
      if (local(name) && (importer.adapted || !entry || local(name) !== read.digests([entry.object]).get(entry.object))) {
        if (outside && !importer.adapted && entry) { fail('destination contains seed-owned bytes'); continue; }
        // Preserve seed-owned bytes, but parse their actual graph so presence
        // cannot conceal a missing dependency. They cannot adopt new Base files.
        const content = files.get(name).read();
        try { if (isCode(source, content, true)) staticImports(content, formatFor(source), source); }
        catch (error) { fail(`destination contains seed-owned bytes with invalid static imports: ${error.message}`); continue; }
        enqueue(importer.plan, source, name, content, importer.boundary, importer.depth + 1, true, importer.pin, true);
        continue;
      }
      if (!entry) { fail('no regular Base file at the target revision'); continue; }
      if (importer.adapted) { fail('seed-owned importer needs explicit dependency reconciliation'); continue; }
      if (importer.depth >= 64) { fail('relative import closure exceeds 64 levels'); continue; }
      // A file excluded at the pin, deleted locally, ignored, or owned by the
      // seed is never silently adopted, even if a new importer requires it.
      const pinned = read.tree(owner ? owner.copy.revision : importer.pin);
      if ((!outside || owner) && pinned.has(source) && !local(name)) { fail('file was kept out at the copy pin'); continue; }
      if ((record.ignore || []).some(prefix => name === prefix || name.startsWith(prefix + '/'))) { fail('file is explicitly ignored'); continue; }
      const content = read.blobs([entry.object]).get(entry.object);
      if (fs.existsSync(path.join(root, name)) && !local(name)) { fail('destination is outside the seed file inventory'); continue; }
      let plan = owner;
      if (plan) {
        if (plan.retired || plan.copy.originPath + name.slice(plan.copy.path.length) !== source) { fail(`destination belongs to a different copy from ${plan.copy.originPath}`); continue; }
        plan.sources.push([source, entry]);
        plan.removed = plan.removed.filter(removed => removed !== name);
      } else {
        // Singleton records cannot contain siblings; preserve the existing
        // schema and mapping by recording each adopted helper as a singleton.
        plan = {copy: {path: name, originPath: source, revision, files: {}}, sources: [[source, entry]], removed: []};
        plans.push(plan);
      }
      adopted.push({path: name, originPath: source});
      enqueue(plan, source, name, content, importer.boundary, importer.depth + 1, false, importer.pin, true);
      scheduled.get(name).delivered = true;
    }
  }
  if (problems.size) throw Error(`Unresolvable relative Base imports; no files were changed:\n${[...problems].sort().join('\n')}`);
  return adopted.sort((a, b) => a.path.localeCompare(b.path));
}
