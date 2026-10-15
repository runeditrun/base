import { readFile, realpath } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { assetInputGuard } from './site-input-assets.mjs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const within = (root, file) => file === root || file.startsWith(root + sep);
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const clean = id => id.replace(/[?#].*$/, '');
export function privateSitePaths(adapter) {
 return [...new Set(['.seed', '.rer', '.wrangler', '.git', '.env', '.dev.vars', adapter.state, adapter.hooks?.secrets?.file, ...(adapter.settings ?? [])].filter(Boolean))];
}

// Build an allowlist from the installed dependency graph, not from the spelling
// "node_modules" in an arbitrary path. pnpm and linked dependency roots are real
// paths; files within a package must still remain inside that package.
export async function clientInputGuard(root, privatePaths, deny, vite) {
 root = await realpath(root);
 const packages = new Set(), seen = new Set(), edges = new Map();
 async function dependencies(directory, isRoot = false) {
  directory = await realpath(directory);
  if (seen.has(directory)) return;
  seen.add(directory);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const allowed = new Set(); edges.set(directory, allowed);
  const names = Object.keys({...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies, ...(isRoot ? pkg.devDependencies : {})});
  for (const name of names) {
   if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) continue;
   let cursor = directory, target;
   while (true) {
    try { target = await realpath(join(cursor, 'node_modules', name)); break; } catch {}
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
   }
   if (!target) continue; // Optional/peer packages may be absent.
   allowed.add(target); packages.add(target);
   await dependencies(target);
  }
 }
 await dependencies(root, true);
 const privateRoots = privatePaths.map(path => resolve(root, path));
 const realPrivate = await Promise.all(privateRoots.map(path => realpath(path).catch(() => path)));
 const packageFor = file => [...packages].filter(path => within(path, file)).sort((a,b) => b.length - a.length)[0];
 const privateFile = file => [...privateRoots, ...realPrivate].some(path => within(path, file)) || relative(root, file).split(sep).some(part => /^(?:\.env(?:\.|$)|\.dev\.vars(?:\.|$)|\.(?:seed|rer|wrangler|git)$)/.test(part));
 async function validate(id, importer) {
  if (builtins.has(id) || id.startsWith('node:') || id.includes('__vite-browser-external')) return deny('site_client_server_import');
  if (id.startsWith('\0') || !isAbsolute(clean(id))) return;
  const file = clean(id), physical = await realpath(file).catch(() => null);
  if (!physical) return;
  if (privateFile(file) || privateFile(physical)) return deny('site_private_input');
  const packageRoot = packageFor(physical);
  if (packageRoot) {
   // A symlink from an allowed package into an unrelated file is not a dependency.
   const lexicalPackage = packageFor(file);
   if (lexicalPackage && lexicalPackage !== packageRoot && !file.includes(`${sep}node_modules${sep}`)) return deny('site_private_input');
   if (importer) {
    const importingFile = isAbsolute(clean(importer)) ? await realpath(clean(importer)).catch(() => clean(importer)) : root;
    const owner = packageFor(importingFile) ?? root;
    if (owner !== packageRoot && !edges.get(owner)?.has(packageRoot)) return deny('site_private_input');
   }
   return;
  }
  if (!within(root, file) || !within(root, physical) || relative(root, file).split(sep).includes('node_modules') || relative(root, physical).split(sep).includes('node_modules')) return deny('site_private_input');
 }
 return [{
  name: 'rer-site-client-inputs', enforce: 'pre',
  resolveId: { order: 'pre', async handler(source, importer, options) {
   await validate(source, importer ?? root);
   const result = await this.resolve(source, importer, {...options, skipSelf:true});
   if (result) { await validate(result.id, importer ?? root); if (result.external) await deny('site_client_server_import'); }
   return result;
  }},
  load: { order: 'pre', async handler(id) { await validate(id); return null; }},
  transform: { order: 'pre', handler: assetInputGuard(root, validate, deny, vite) },
 }, {
  // Normal user transforms (including TSX/framework plugins) run before Vite's
  // asset URL rewrite. Check their generated JavaScript at that boundary too.
  name: 'rer-site-transformed-assets',
  transform: assetInputGuard(root, validate, deny, vite, true),
 }];
}
