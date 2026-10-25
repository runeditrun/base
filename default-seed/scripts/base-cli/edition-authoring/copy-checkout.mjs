import fs from 'node:fs';
import path from 'node:path';
import {git, raw, safe, noLinks} from './files.mjs';
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

// Legacy seeds recorded the authoring CLI one file at a time. Ship its maintained
// source set as siblings too; this is deliberately limited to Base's own tools,
// independent of the runtime dependency planner and edition application source.
export function completeAuthoringCopies(root, plans, {tree, revision}) {
  const mounts = new Set(plans.flatMap(plan => plan.sources
    .filter(([source]) => source === 'edition-authoring/cli.mjs')
    .map(([source]) => path.posix.dirname(plan.copy.path + source.slice(plan.copy.originPath.length)))));
  const sources = [...tree].filter(([source]) => /^edition-authoring\/[^/]+\.mjs$/.test(source) && !source.endsWith('.test.mjs'));
  for (const mount of mounts) for (const [source, entry] of sources) {
    const target = safe(mount + '/' + path.posix.basename(source));
    noLinks(root, target);
    const exists = fs.existsSync(path.join(root, target));
    if (exists && !fs.lstatSync(path.join(root, target)).isFile()) throw Error(`Authoring helper is not a regular file: ${target}`);
    let plan = plans.find(plan => target === plan.copy.path || target.startsWith(plan.copy.path + '/'));
    if (plan && plan.copy.originPath + target.slice(plan.copy.path.length) !== source) throw Error(`Authoring helper conflicts with Base copy mapping: ${target}`);
    if (plan?.removed.includes(target)) throw Error(`Authoring helper was removed locally: ${target}. Restore it before refreshing; no files were refreshed.`);
    // Git may omit ignored files; neither omission nor matching Base bytes grants ownership.
    if (exists && !Object.hasOwn(plan?.copy.files ?? {}, target)) throw Error(`Authoring helper destination already exists without a Base copy record: ${target}. Record or adapt it before refreshing; no files were refreshed.`);
    if (plan?.sources.some(([name]) => name === source) || plan?.copy.adapted?.[target]) continue;
    if (!plan) {
      if (plans.some(plan => plan.copy.path.startsWith(target + '/'))) throw Error(`Authoring helper overlaps a Base copy: ${target}`);
      plan = {copy: {path: target, originPath: source, revision, files: {}, modes: {}}, sources: [], removed: []};
      plans.push(plan);
    }
    plan.sources.push([source, entry]);
  }
}

// Inspect the completed plan without creating, truncating, chmodding or removing
// anything. This catches known filesystem obstructions, not failures that arise
// after preflight (concurrent changes, exhausted space or I/O failures).
export function preflightRefresh(root, plans, recordPath) {
  const writes = new Set([recordPath, ...plans.flatMap(({copy, sources}) =>
    sources.map(([source]) => copy.path + source.slice(copy.originPath.length)))]);
  // Acknowledgements live in the copy record. An existing source lock must also
  // remain writable, although refresh does not regenerate it.
  if (fs.existsSync(path.join(root, 'sources.lock.json'))) writes.add('sources.lock.json');
  const removals = plans.flatMap(plan => plan.removed).filter(name => !writes.has(name));
  const uid = process.geteuid?.(), entries = new Map();
  const writable = (target, stat, directory = false) => {
    // Root's DAC bypass must not turn explicitly read-only inputs into writes.
    if (uid === 0 && !(stat.mode & 0o222)) throw Error('no write permission bits');
    fs.accessSync(target, fs.constants.W_OK | (directory ? fs.constants.X_OK : 0));
  };
  const inspect = name => {
    safe(name);
    let parent = root, parentStat = fs.lstatSync(root);
    const parts = name.split('/');
    for (const [index, part] of parts.entries()) {
      if (!entries.has(parent)) entries.set(parent, fs.readdirSync(parent));
      const variant = entries.get(parent).find(entry => entry !== part && entry.toLowerCase() === part.toLowerCase());
      if (variant) throw Error(`case-variant destination exists: ${path.relative(root, path.join(parent, variant))}`);
      const target = path.join(parent, part);
      let stat;
      try { stat = fs.lstatSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) throw Error(`symlink in destination path: ${path.relative(root, target)}`);
      if (!stat || index === parts.length - 1) return {target, stat, parent, parentStat};
      if (!stat.isDirectory()) throw Error(`directory required at ${path.relative(root, target)}`);
      parent = target; parentStat = stat;
    }
  };
  for (const name of new Set([...writes, ...removals])) {
    try {
      const {target, stat, parent, parentStat} = inspect(name);
      if (!writes.has(name) && !stat) continue;
      if (stat && !stat.isFile()) throw Error('destination is not a regular file');
      // This is also the nearest existing ancestor of any missing directories.
      writable(parent, parentStat, true);
      if (stat && uid !== undefined && uid !== 0 && (parentStat.mode & 0o1000) && uid !== parentStat.uid && uid !== stat.uid) {
        throw Error('sticky directory prevents replacing the directory entry');
      }
      if (stat && writes.has(name)) {
        writable(target, stat);
        // The write loop sets the delivered mode as well as the bytes.
        if (uid !== undefined && uid !== 0 && uid !== stat.uid) throw Error('file is owned by another user; cannot set its mode');
        const fd = fs.openSync(target, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
        fs.closeSync(fd);
      }
    } catch (error) {
      throw Error(`Cannot refresh ${name}: ${error.message}. Fix the named path and its parent permissions before refreshing; no files were refreshed.`);
    }
  }
}
