import fs from 'node:fs';
import path from 'node:path';
import {git, raw, safe, noLinks, testSource} from './files.mjs';
import {specifiers} from './runtime-dependencies.mjs';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// -v marks assume-unchanged; -f marks fsmonitor-valid. Read them separately
// because either option can lowercase the normal checkout-state tag.
function index(root) {
  try {
    const read = flag => new Map(raw(root, 'ls-files', '--stage', flag, '-z').toString('utf8').split('\0').filter(Boolean).map(line => {
      const match = /^([HSMRCK?hsmrck]) ([0-7]{6}) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(line);
      if (!match) throw Error('Unsupported index entry');
      return [safe(match[4]), {tag: match[1], mode: match[2], object: match[3]}];
    }));
    const entries = read('-v'), monitor = read('-f');
    if (entries.size !== monitor.size) throw Error('Index changed');
    for (const [name, entry] of entries) {
      const other = monitor.get(name);
      if (!other || entry.mode !== other.mode || entry.object !== other.object) throw Error('Index changed');
      entry.monitor = other.tag;
    }
    return entries;
  } catch {
    throw Error('Cannot read or interpret the Git index to decide whether Base copies were removed. Run git status and repair the checkout, then repeat refresh-base. No copy record was changed.');
  }
}

// Absence alone is a removal signal only in a complete checkout. For a
// materialized submodule, inspect its own index and read the recorded child;
// the parent index lists the gitlink, never the child's files.
export function requireMaterializedCopies(root, record, files) {
  const indexes = new Map();
  const entriesAt = directory => {
    if (!indexes.has(directory)) indexes.set(directory, index(directory));
    return indexes.get(directory);
  };
  entriesAt(root);
  for (const name of record.copies.flatMap(copy => Object.keys(copy.files))) {
    let directory = root, relative = name;
    for (;;) {
      const entries = entriesAt(directory), entry = entries.get(relative);
      const link = [...entries].find(([prefix, value]) => value.mode === '160000' && relative.startsWith(prefix + '/'));
      if (link) {
        const prefix = path.relative(root, path.join(directory, link[0])).split(path.sep).join('/');
        const child = path.join(root, prefix);
        let initialized = false;
        try { initialized = fs.realpathSync(git(child, 'rev-parse', '--show-toplevel')) === fs.realpathSync(child); } catch {}
        if (!initialized) throw Error(`Base copy ${name} is beneath the uninitialized Git submodule ${prefix}. Run git -C ${quote(directory)} submodule update --init -- ${quote(link[0])}, then repeat refresh-base. No copy record was changed.`);
        relative = relative.slice(link[0].length + 1);
        directory = child;
        continue;
      }
      const target = path.join(root, name);
      if (!fs.existsSync(target)) {
        const repairs = [];
        if (entry?.tag.toUpperCase() === 'S') repairs.push('git sparse-checkout disable');
        if (entry && entry.tag === entry.tag.toLowerCase()) repairs.push(`git update-index --no-assume-unchanged -- ${quote(relative)}`);
        if (entry && entry.monitor === entry.monitor.toLowerCase()) repairs.push(`git update-index --no-fsmonitor-valid -- ${quote(relative)}`);
        if (directory !== root) repairs.push(`git restore -- ${quote(relative)}`);
        if (repairs.length) throw Error(`Base copy ${name} has incomplete Git checkout evidence, not a confirmed removal. In ${directory}, run ${repairs.join(', then ')}, restore the file if absent, then repeat refresh-base. No copy record was changed.`);
      } else if (directory !== root) {
        noLinks(root, name);
        const stat = fs.lstatSync(target);
        files.set(name, {regular: stat.isFile(), executable: !!(stat.mode & 0o100), read: () => fs.readFileSync(target)});
      }
      break;
    }
  }
}

// Every recorded authoring module is a root, including exported mirrors and
// local adaptations. Edition-owned tracked siblings end traversal at that edge.
export function completeAuthoringImports(root, plans, {tree, read, revision, base}) {
  const mapped = (name, copy) => copy.path + name.slice(copy.originPath.length);
  const authoring = name => path.posix.basename(path.posix.dirname(name)) === 'edition-authoring' && name.endsWith('.mjs') && !testSource(name);
  const tracked = index(root), planned = new Map(), recorded = new Map(), queue = [];
  for (const plan of plans) {
    for (const name of Object.keys(plan.copy.files)) recorded.set(name, plan);
    for (const [source, entry] of plan.sources) {
      const target = mapped(source, plan.copy);
      planned.set(target, plan);
      if (authoring(source)) queue.push({source, target, entry});
    }
    for (const target of Object.keys(plan.copy.adapted || {})) {
      const source = plan.copy.originPath + target.slice(plan.copy.path.length);
      if (authoring(source)) queue.push({source, target, adapted: true});
    }
  }
  const refuse = (target, reason, command) => {
    throw Error(`Cannot refresh authoring import ${target}: ${reason}. Run ${command}, then repeat refresh-base; no files were refreshed.`);
  };
  const move = target => `mv -i -- ${quote(target)} ${quote(target + '.refresh-backup')}`;
  // Unlike the write preflight, closure must also validate files it only relies
  // on. Read actual directory entries to reject aliases, never infer volume case.
  function inspect(target) {
    const parts = safe(target).split('/');
    let parent = root;
    for (const [i, part] of parts.entries()) {
      const absolute = path.join(parent, part), name = parts.slice(0, i + 1).join('/');
      let stat;
      try { stat = fs.lstatSync(absolute); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        refuse(name, error.message, move(name));
      }
      if (!fs.readdirSync(parent).includes(part)) refuse(name, 'the volume resolves a differently spelled entry', move(name));
      if (stat.isSymbolicLink()) refuse(name, 'symlink in import path', move(name));
      if (i < parts.length - 1 && !stat.isDirectory()) refuse(name, 'import parent is not a directory', move(name));
      if (i === parts.length - 1) {
        if (!stat.isFile()) refuse(name, 'import is not a regular file', move(name));
        return stat;
      }
      parent = absolute;
    }
  }
  const blobs = new Map(), seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const {source, target, entry, adapted} = queue[i];
    if (seen.has(target)) continue;
    seen.add(target);
    inspect(target);
    let bytes;
    if (adapted) bytes = fs.readFileSync(path.join(root, target), 'utf8');
    else {
      if (!blobs.has(entry.object)) blobs.set(entry.object, read.blobs([entry.object]).get(entry.object).toString('utf8'));
      bytes = blobs.get(entry.object);
    }
    for (const specifier of specifiers(bytes)) {
      const directory = path.posix.dirname(source);
      const dependency = path.posix.normalize(path.posix.join(directory, specifier));
      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(target), specifier));
      if (path.posix.dirname(dependency) !== directory) {
        refuse(target, `import ${specifier} leaves its directory`, `\${EDITOR:-vi} ${quote(target)}`);
      }
      const exists = inspect(destination), owner = recorded.get(destination);
      if (owner?.removed.includes(destination)) {
        const original = owner.copy.originPath + destination.slice(owner.copy.path.length);
        const restore = tracked.has(destination) ? `git restore -- ${quote(destination)}` :
          `git -C ${quote(base)} show ${quote(owner.copy.revision + ':' + original)} > ${quote(destination)}`;
        refuse(destination, 'recorded file was removed but is still imported', restore);
      }
      if (planned.has(destination) || owner) continue;
      if (tracked.has(destination)) {
        if (!exists) refuse(destination, 'tracked edition source is missing', `git restore -- ${quote(destination)}`);
        continue;
      }
      if (exists) refuse(destination, 'existing file has no Base copy record or Git index entry', `git add -f -- ${quote(destination)}`);
      const value = tree.get(dependency);
      if (!value) refuse(destination, `no source at ${dependency} in ${revision}`, `\${EDITOR:-vi} ${quote(target)}`);
      // A directory copy can already own this destination's namespace. Extend
      // that record; otherwise the dependency is a new singleton copy.
      let plan = plans.find(plan => destination.startsWith(plan.copy.path + '/'));
      if (plan && mapped(dependency, plan.copy) !== destination) {
        refuse(destination, 'source cannot fit its enclosing copy record', `\${EDITOR:-vi} base-copies.json`);
      }
      if (!plan) {
        if (plans.some(plan => plan.copy.path.startsWith(destination + '/'))) refuse(destination, 'overlaps a copy directory', `\${EDITOR:-vi} base-copies.json`);
        plan = {copy: {path: destination, originPath: dependency, revision, files: {}, modes: {}}, sources: [], removed: []};
        plans.push(plan);
      }
      plan.sources.push([dependency, value]);
      planned.set(destination, plan);
      queue.push({source: dependency, target: destination, entry: value});
    }
  }
}

// Inspect real filesystem facts in apply order without opening or changing any
// file. This cannot see later races, disk-space or I/O failures, umask on newly
// created directories, or two new names differing only in case on an insensitive
// volume. Only earlier removals are remembered; no future directory is modelled.
export function preflightRefresh(root, plans, recordPath, seedFiles) {
  const uid = process.geteuid?.(), freed = new Set();
  const identity = (name, stat) => stat.nlink > 1 ? name : `${stat.dev}:${stat.ino}`;
  const writable = (target, stat, directory = false) => {
    if (uid === 0 && !(stat.mode & 0o222)) throw Error('no write permission bits');
    fs.accessSync(target, fs.constants.W_OK | (directory ? fs.constants.X_OK : 0));
  };
  function inspect(name) {
    let parent = root, parentStat = fs.lstatSync(root);
    if (!parentStat.isDirectory()) throw Error('checkout root is not a directory');
    const parts = safe(name).split('/');
    for (const [i, part] of parts.entries()) {
      const target = path.join(parent, part), relative = parts.slice(0, i + 1).join('/');
      let stat;
      try { stat = fs.lstatSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stat || (stat.isFile() && freed.has(identity(relative, stat)))) return {parent, parentStat};
      if (i === parts.length - 1) {
        if (!stat.isFile()) throw Error('destination is not a regular file');
        return {parent, parentStat, target, stat};
      }
      if (!stat.isDirectory()) throw Error(`directory required at ${relative}`);
      parent = target; parentStat = stat;
    }
  }
  function check(name, operation) {
    try {
      const found = inspect(name), {parent, parentStat, target, stat} = found;
      if (operation === 'remove') {
        if (!stat) return;
        writable(parent, parentStat, true);
        if (uid !== undefined && uid !== 0 && (parentStat.mode & 0o1000) && uid !== parentStat.uid && uid !== stat.uid) throw Error('sticky parent and file are owned by another user');
        freed.add(identity(name, stat));
      } else if (stat) {
        if (operation !== 'record' && !seedFiles.has(name)) throw Error('existing destination is ignored or resolves a differently spelled entry');
        writable(target, stat);
        if (operation !== 'record' && uid !== undefined && uid !== 0 && uid !== stat.uid) throw Error('file is owned by another user; cannot set its mode');
      } else writable(parent, parentStat, true);
    } catch (error) {
      throw Error(`Cannot refresh ${name}: ${error.message}. Fix the named path and its parent permissions before refreshing; no files were refreshed.`);
    }
  }
  for (const {copy, sources, removed} of plans) {
    for (const name of removed) check(name, 'remove');
    for (const [source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) check(copy.path + source.slice(copy.originPath.length), 'write');
  }
  check(recordPath, 'record');
}
