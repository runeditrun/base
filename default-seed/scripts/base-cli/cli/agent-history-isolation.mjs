import { readdir, readFile, realpath } from 'node:fs/promises';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { testSource } from '../composition/git-source.mjs';
import { dependencies } from '../edition-authoring/module-edges.mjs';
import { resolve as resolveModule } from '../edition-authoring/module-resolution.mjs';
import { RerError } from './errors.mjs';

const productionHistory = (name, target = name) => new RerError('agent_history_invalid', `agent_history_invalid: Production file ${name} references verification-only history module ${target}.`, 1);

// Check runtime import edges without executing test code. Scan source as well as
// unbundled output, following literal imports/re-exports, import.meta.url
// resources (including Workers), TS paths and symlinks.
// Shared native helpers remain usable by production; only the fixture's tests/
// modules are barred. An undeclared seed performs no additional scan.
export async function refuseHistoryImports(root, source) {
 const files = new Set(), physical = new Map();
 const ignored = new Set(['node_modules', '.git', '.rer', '.wrangler', '.seed', '.cache', 'test-results', 'playwright-report']);
 async function walk(directory = '') {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
   if (ignored.has(entry.name)) continue;
   const name = directory ? directory + '/' + entry.name : entry.name;
   if (entry.isDirectory()) await walk(name);
   else if (entry.isFile() || entry.isSymbolicLink()) {
    files.add(name);
    physical.set(name, await realpath(join(root, name)));
   }
  }
 }
 await walk();
 const forbidden = new Set(await Promise.all(source.modules.filter(module => relative(source.root, module.path).startsWith('tests/')).map(module => realpath(module.path))));
 const tree = { has: name => {
  if (files.has(name)) return true;
  if (name.startsWith('../') || name.split('/').some(part => ignored.has(part))) return false;
  // Literal imports may cross a contained directory symlink that the directory
  // walk deliberately does not follow. Resolve that file physically too.
  try {
   if (!statSync(join(root, name)).isFile()) return false;
   files.add(name); physical.set(name, realpathSync(join(root, name)));
   return true;
  } catch { return false; }
 }, read: name => readFileSync(join(root, name), 'utf8') };
 let paths = {};
 try { paths = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')).compilerOptions?.paths ?? {}; } catch { /* Relative resolution still applies. */ }
 const queue = [...files].filter(name => !testSource(name) && !name.startsWith('scripts/') && /\.[cm]?[jt]sx?$/.test(name)), seen = new Set();
 while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  if (forbidden.has(physical.get(name))) throw productionHistory(name);
  for (const request of dependencies(await readFile(join(root, name), 'utf8'), name).filter(request => !request.types)) {
   const candidates = [request.specifier];
   for (const [alias, targets] of Object.entries(paths)) {
    const [prefix, suffix = ''] = alias.split('*');
    if (alias.includes('*') ? request.specifier.startsWith(prefix) && request.specifier.endsWith(suffix) : request.specifier === alias) {
     for (const target of targets) candidates.push('./' + relative(resolve(root, name, '..'), resolve(root, target.replace('*', request.specifier.slice(prefix.length, suffix ? -suffix.length : undefined)))));
    }
   }
   for (const specifier of candidates) {
    const target = resolveModule(tree, name, specifier, request);
    if (typeof target === 'string') {
     if (forbidden.has(physical.get(target))) throw productionHistory(name, target);
     if (/\.[cm]?[jt]sx?$/.test(target)) queue.push(target);
    }
   }
  }
 }
}
