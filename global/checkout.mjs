// Find the project an invocation acts on: the nearest OPERATIONS.json at or
// above the working directory, or exactly --cwd DIR. Then pick whose code runs it.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { exactVersion } from '../cli/package-mode.mjs';
import { ownRoot, packageName } from './package-info.mjs';

// The value of --cwd among the wrapper flags (never after a -- separator).
function cwdFlag(args) {
 for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') return undefined;
  if (args[i] === '--cwd') return { index: i + 1, value: args[i + 1] };
 }
 return undefined;
}

export function descriptorProfile(file) {
 let descriptor;
 try { descriptor = JSON.parse(readFileSync(file, 'utf8')); } catch { return { profile: 'unreadable' }; }
 if (descriptor?.version === 2) return { profile: descriptor.seedContract ? 'first-party' : 'independent' };
 return { profile: 'unsupported', version: descriptor?.version };
}

const projectRoot = directory => { try { return statSync(join(directory, 'OPERATIONS.json')).isFile() ? realpathSync(directory) : undefined; } catch { return undefined; } };

// --cwd names the project root itself, as the pinned dispatcher reads it: no
// upward search. When it names no project, the dispatcher of the checkout
// around the working directory (else this package's own) receives it
// unchanged, as an absolute path, and refuses it with its own message.
export function locate(argv) {
 const flag = cwdFlag(argv.slice(1)), args = [...argv];
 if (flag?.value !== undefined) {
  // A value the dispatcher's parser rejects (empty, or another flag) reaches it as given.
  const usable = flag.value.trim() && !flag.value.startsWith('--'), named = resolve(process.cwd(), flag.value), root = usable ? projectRoot(named) : undefined;
  if (root) { args[flag.index + 1] = root; return { root, args, ...descriptorProfile(join(root, 'OPERATIONS.json')) }; }
  if (usable) args[flag.index + 1] = named;
  const near = around(process.cwd());
  return { root: near && ['first-party', 'independent'].includes(descriptorProfile(join(near, 'OPERATIONS.json')).profile) ? near : undefined, args, profile: 'refused' };
 }
 const root = around(process.cwd());
 return { root, args, ...(root ? descriptorProfile(join(root, 'OPERATIONS.json')) : { profile: 'none' }) };
}

// The nearest project root at or above a directory.
function around(start) {
 for (let directory = start; ; directory = dirname(directory)) {
  const root = projectRoot(directory);
  if (root) return root;
  if (dirname(directory) === directory) return undefined;
 }
}

export function unsupportedMessage(root, version) {
 return `${join(root, 'OPERATIONS.json')} is an OPERATIONS version ${version ?? '(none)'} descriptor, which rer does not run. Use the commands that project documents, or move it to OPERATIONS version 2.`;
}

// The rer package a checkout pins in package.json (package mode): the declared
// specifier, the version node_modules holds, and whether that installed copy is
// the one to run (`ready`: present, and equal to an exact pin). undefined for a
// checkout that does not declare it.
export function pinnedPackage(root) {
 let manifest;
 try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return undefined; }
 const declared = manifest.devDependencies?.[packageName] ?? manifest.dependencies?.[packageName];
 if (!declared) return undefined;
 let installed;
 try { installed = JSON.parse(readFileSync(join(root, 'node_modules', packageName, 'package.json'), 'utf8')).version; } catch {}
 return { declared, installed, ready: installed !== undefined && (installed === declared || !exactVersion.test(declared)) };
}

// What runs a checkout's verbs: `entry` is the dispatcher (the verbs
// themselves) and, for a pinned package, `launcher` is its own rer command.
// 1. the checkout's own pinned package, once node_modules holds the version
// package.json pins (see pinnedPackage), 2. its vendored scripts/rer.mjs, 3. this package's
// bundled dispatcher.
export function dispatcher(root) {
 const pinned = root ? pinnedPackage(root) : undefined;
 if (pinned?.ready) {
  const location = realpathSync(join(root, 'node_modules', packageName));
  // This package is that pin: it runs the checkout itself, whatever else the checkout holds.
  if (location === ownRoot) return { mode: 'bundled', entry: join(ownRoot, 'bin/rer.mjs') };
  if (existsSync(join(location, 'global/rer.mjs'))) return { mode: 'package', entry: join(location, 'bin/rer.mjs'), launcher: join(location, 'global/rer.mjs') };
 }
 if (root && existsSync(join(root, 'scripts/rer.mjs'))) return { mode: 'vendored', entry: join(root, 'scripts/rer.mjs') };
 return { mode: 'bundled', entry: join(ownRoot, 'bin/rer.mjs') };
}
