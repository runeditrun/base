import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, parse } from 'node:path';
import { blockedSignal } from './detector.mjs';
import { denied, example, readable, skipped } from './policy.mjs';
import { parseNames } from './parsers.mjs';
import { configKeyLimit } from './config-policy.mjs';

// Caller-named roots are canonicalized once; below them, refuse symlink
// ancestors as well as symlink entries before reading any file content.
async function plainAncestors(path) {
 const root = parse(path).root;
 let current = root;
 for (const part of path.slice(root.length).split('/').filter(Boolean)) {
  current = join(current, part);
  if ((await lstat(current)).isSymbolicLink()) return false;
 }
 return true;
}

async function namesFromFile(path, info, locator, pulumi) {
 if (!readable(locator) && !(pulumi && /\.(?:[cm]?[jt]sx?|py|go|cs)$/i.test(locator))) return [];
 // O_NOFOLLOW blocks a replaced leaf; compare the opened inode before reading.
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const opened = await file.stat();
  if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || !await plainAncestors(dirname(path))) throw Error('Changed scan input');
  return parseNames(locator, await file.readFile('utf8'));
 } finally { await file.close(); }
}

export async function scan(directories) {
 const result = { schema: 'rer-business-signals/1', source: 'local', configKeyLimit, signals: [], withheld: 0 };
 const observedAt = new Date().toISOString(), seen = new Set(), grouped = new Map();
 const roots = [...new Set(directories.map(path => resolve(path)))];
 function emit(signal) {
  if (blockedSignal(signal)) { result.withheld++; return; }
  // Denied files retain their own locator, size and mtime, even when names match.
  if (signal.kind === 'secret-file') { result.signals.push(signal); return; }
  const key = JSON.stringify([signal.kind, signal.value, signal.repo, signal.class]);
  const existing = grouped.get(key);
  if (existing) existing.count++;
  else {
   const counted = { ...signal, count: 1 };
   grouped.set(key, counted);
   result.signals.push(counted);
  }
 }
 for (const requested of roots) {
  const root = await realpath(requested);
  const rootInfo = await lstat(root), base = rootInfo.isDirectory() ? root : dirname(root), repo = basename(base);
  async function walk(path, pulumi = false) {
   if (skipped(relative(root, path)) || seen.has(path)) return;
   seen.add(path);
   const info = await lstat(path);
   if (info.isSymbolicLink()) return;
   if (info.isDirectory()) {
    const names = (await readdir(path)).sort();
    pulumi ||= names.some(name => /^Pulumi\.ya?ml$/i.test(name));
    for (const name of names) await walk(join(path, name), pulumi);
   } else if (info.isFile()) {
    const locator = relative(base, path).split('\\').join('/');
    const common = { locator, repo, class: example(locator) ? 'trace' : 'live-use', observedAt };
    // A caller-named store remains metadata-only even when it is an alias.
    if (denied(path) || denied(join(requested, relative(root, path)))) {
     emit({ kind: 'secret-file', value: basename(path), ...common, size: info.size, mtime: info.mtime.toISOString() });
     return;
    }
    for (const name of await namesFromFile(path, info, locator, pulumi)) {
     emit({ ...common, kind: name.kind, value: name.value, class: name.class ?? common.class });
    }
   }
  }
  await walk(root);
 }
 return result;
}
