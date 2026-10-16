import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { blockedSignal } from './detector.mjs';
import { denied, example, gitDirectory, readable, skipped, toolDirectory } from './policy.mjs';
import { parseNames } from './parsers.mjs';
import { configuration, configKeyLimit } from './config-policy.mjs';
import { readPlainFile } from './files.mjs';
import { repositoryBoundary } from './repository.mjs';

async function namesFromFile(path, info, locator, pulumi) {
 // Executable configs are not inputs, even inside a Pulumi project. Their
 // dependencies are discovered through manifests instead.
 if (configuration(locator) && /\.[cm]?[jt]sx?$/i.test(locator)) return [];
 if (!readable(locator) && !(pulumi && /\.(?:[cm]?[jt]sx?|py|go|cs)$/i.test(locator))) return [];
 return parseNames(locator, await readPlainFile(path, info));
}

export async function scan(directories) {
 const result = { schema: 'rer-business-signals/1', source: 'local', configKeyLimit, signals: [], withheld: 0,
  skipped: { linkedWorktrees: 0, toolDirectories: 0, generatedDirectories: 0, gitDirectories: 0 } };
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
  const rootInfo = await lstat(root), base = rootInfo.isDirectory() ? root : dirname(root);
  async function walk(path, repository, pulumi = false) {
   if (seen.has(path)) return;
   seen.add(path);
   const info = await lstat(path);
   if (info.isSymbolicLink()) return;
   const requestedPath = join(requested, relative(root, path));
   const skip = toolDirectory(path) || toolDirectory(requestedPath) ? 'toolDirectories' :
    gitDirectory(path) || gitDirectory(requestedPath) ? 'gitDirectories' : skipped(relative(root, path));
   if (skip) {
    if (info.isDirectory()) result.skipped[skip]++;
    return;
   }
   if (info.isDirectory()) {
    const boundary = await repositoryBoundary(path, denied(path) || denied(requestedPath));
    if (boundary === 'linkedWorktree') { result.skipped.linkedWorktrees++; return; }
    if (boundary === 'repository') { repository = path; pulumi = false; }
    const names = (await readdir(path)).sort();
    pulumi ||= names.some(name => /^Pulumi\.ya?ml$/i.test(name));
    for (const name of names) await walk(join(path, name), repository, pulumi);
   } else if (info.isFile()) {
    const locator = relative(repository, path).split('\\').join('/');
    const common = { locator, repo: basename(repository), class: example(locator) ? 'trace' : 'live-use', observedAt };
    // A caller-named store remains metadata-only even when it is an alias.
    if (denied(path) || denied(requestedPath)) {
     emit({ kind: 'secret-file', value: basename(path), ...common, size: info.size, mtime: info.mtime.toISOString() });
     return;
    }
    for (const name of await namesFromFile(path, info, locator, pulumi)) {
     emit({ ...common, kind: name.kind, value: name.value, class: name.class ?? common.class });
    }
   }
  }
  await walk(root, base);
 }
 return result;
}
