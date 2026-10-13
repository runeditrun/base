// Convert a vendored first-party seed to package mode:
//   node scripts/export-cli.mjs --to-package SEED_ROOT [--version X]
// The seed stops carrying scripts/rer.mjs, scripts/base-cli and
// scripts/base-onboarding and pins @runeditrun/rer X (default: the latest
// published version) as an exact devDependency, locked in pnpm-lock.yaml.
// Imports into the vendored copy become the package's exports, package scripts
// and OPERATIONS argv run `rer VERB`, delivery operations, the shell scripts
// they and CI workflows run, and workflow lines run `pnpm exec rer VERB` (see
// calls.mjs), and base-copies.json drops only the
// records of the removed copy (app-runtime copies stay as they are). It
// refuses, listing them, when the vendored copy holds local edits.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { packageFiles } from '../rer-package.mjs';
import { declaredPackage, exactVersion, packageName, vendoredPaths } from '../../cli/package-mode.mjs';
import { testSource } from '../../composition/git-source.mjs';
import { planCalls } from './calls.mjs';
import { planMetadata } from './metadata.mjs';
import { rewriteTestLaunches } from './test-launches.mjs';
import { rewritePackageMarkdown } from './markdown.mjs';
import { copyChecks, withoutCopyChecks } from './copy-checks.mjs';

const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// The exact text the vendored export writes as scripts/rer.mjs.
const vendoredEntry = "#!/usr/bin/env node\nimport { main } from './base-cli/cli/main.mjs';\nprocess.exitCode = await main();\n";
// Checkout folders that are not seed source: dependencies, build output and local state.
const skipped = new Set(['node_modules', '.git', 'dist', '.wrangler', '.rer', '.seed', '.cache', '.state', '__pycache__', 'test-results', 'playwright-report']);
const sourceFile = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/;
const textFile = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|json|jsonc|md|sh|yml|yaml|toml)$/;

export class Refusal extends Error { constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; } }

async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function files(root, directory = '', skip = new Set()) {
 const found = [];
 let entries;
 try { entries = await readdir(join(root, directory), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return found; throw error; }
 for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  const path = directory ? `${directory}/${entry.name}` : entry.name;
  if (skipped.has(entry.name) || skip.has(path)) continue;
  if (entry.isDirectory()) found.push(...await files(root, path, skip));
  else if (entry.isFile()) found.push(path);
 }
 return found;
}

// Files of the vendored copy that differ from what its inventory recorded.
// Base's own test sources that an older export carried beside the inventory
// are not edits: they leave with the copy (`baseTests`).
async function localEdits(base, root) {
 const record = JSON.parse(await readFile(join(root, 'scripts/base-cli/inventory.json'), 'utf8'));
 const edits = [], baseTests = [];
 for (const [folder, recorded, prefix] of [['scripts/base-cli', record.files ?? {}, ''], ['scripts/base-onboarding', record.onboardingFiles ?? {}, 'onboarding/']]) {
  const actual = (await files(root, folder)).map(path => path.slice(folder.length + 1)).filter(path => !(folder === 'scripts/base-cli' && path === 'inventory.json'));
  for (const path of actual) {
   if (!recorded[path] && testSource(prefix + path) && await exists(join(base, prefix + path))) baseTests.push(`${folder}/${path}`);
   else if (!recorded[path]) edits.push({ path: `${folder}/${path}`, change: 'added' });
   else if (sha256(await readFile(join(root, folder, path))) !== recorded[path].sha256) edits.push({ path: `${folder}/${path}`, change: 'edited', packagePath: prefix + path });
  }
  for (const path of Object.keys(recorded)) if (!actual.includes(path)) edits.push({ path: `${folder}/${path}`, change: 'removed', packagePath: prefix + path });
 }
 if (await readFile(join(root, 'scripts/rer.mjs'), 'utf8') !== vendoredEntry) edits.push({ path: 'scripts/rer.mjs', change: 'edited', note: 'a custom entry point: move what it adds into the seed (its adapter or own scripts), or upstream it' });
 return { edits, baseTests };
}

// The registry's record of a version (the latest when none is given), read
// with the seed's own npm configuration.
async function published(root, version) {
 let stdout;
 try { ({ stdout } = await run('npm', ['view', `${packageName}@${version ?? 'latest'}`, 'version', 'exports', '--json'], { cwd: root, env: process.env, maxBuffer: 4 * 1024 * 1024 })); }
 catch (error) { throw new Refusal(`npm view ${packageName}@${version ?? 'latest'} failed: ${(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')}`); }
 const value = JSON.parse(stdout.trim() || 'null');
 const record = typeof value === 'string' ? { version: value } : Array.isArray(value) ? value.at(-1) : value;
 if (!record?.version) throw new Refusal(`The registry has no ${packageName}${version ? ` ${version}` : ''}.`);
 return { version: record.version, exports: record.exports ?? {} };
}

// The seed-root path a vendored path stands for in the package, or undefined.
function packagePath(path) {
 if (path === 'scripts/rer.mjs') return 'bin/rer.mjs';
 for (const [folder, prefix] of [['scripts/base-cli', ''], ['scripts/base-onboarding', 'onboarding']]) {
  if (path === folder) return prefix;
  if (path.startsWith(folder + '/')) return (prefix ? prefix + '/' : '') + path.slice(folder.length + 1);
 }
 return undefined;
}

// The import specifier for a package file: its named export, else the
// package's internal path (no stability promise beyond the pinned version).
function specifierFor(exportsMap, path) {
 for (const [key, value] of Object.entries(exportsMap)) {
  const target = typeof value === 'string' ? value : value?.default;
  if (target === './' + path && !key.includes('*')) return `${packageName}${key.slice(1)}`;
 }
 return `${packageName}/internal/${path}`;
}

function exported(exportsMap, specifier) {
 const key = '.' + specifier.slice(packageName.length);
 return Object.hasOwn(exportsMap, key) || Object.keys(exportsMap).some(pattern => pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1)));
}

// Rewrite one source file's references into the vendored copy. Import
// specifiers become package specifiers; other path strings (relative to the
// file, or to the seed root) point at node_modules/@runeditrun/rer instead.
function rewriteSource(text, file, { exportsMap, known, changes }) {
 const directory = dirname(file);
 const target = (literal, from) => {
  const path = relative('.', join(from, literal)).split(sep).join('/');
  const inPackage = packagePath(path);
  return inPackage !== undefined && known(inPackage) ? inPackage : undefined;
 };
 const note = (from, to) => changes.push({ file, from, to });
 const contexts = [
  /(\bnew URL\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\2(\s*,\s*import\.meta\.url\s*\))/g,
  /(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/g,
 ];
 text = text.replace(contexts[0], (whole, open, quote, literal, close) => {
  const path = target(literal, directory);
  if (path === undefined) return whole;
  const specifier = specifierFor(exportsMap, path);
  note(literal, specifier);
  return `new URL(import.meta.resolve(${quote}${specifier}${quote}))`;
 });
 text = text.replace(contexts[1], (whole, open, quote, literal) => {
  const path = target(literal, directory);
  if (path === undefined) return whole;
  const specifier = specifierFor(exportsMap, path);
  note(literal, specifier);
  return `${open}${quote}${specifier}${quote}`;
 });
 return text.replace(/(['"])((?:\.{1,2}\/|\.\/)?(?:\.\.\/)*scripts\/(?:rer\.mjs|base-cli|base-onboarding)[^'"\n]*)\1/g, (whole, quote, literal) => {
  const relativeToFile = literal.startsWith('.');
  const path = target(literal, relativeToFile ? directory : '.');
  if (path === undefined) return whole;
  const installed = `node_modules/${packageName}${path ? '/' + path : ''}`;
  let replacement = relativeToFile ? relative(directory, installed).split(sep).join('/') : installed;
  if (relativeToFile && !replacement.startsWith('.')) replacement = './' + replacement;
  note(literal, replacement);
  return quote + replacement + quote;
 });
}

const packageScript = command => command
 .replace(/\bnode\s+(?:\.\/)?scripts\/rer\.mjs\b/g, 'rer')
 .replace(/\bnode\s+(?:\.\/)?scripts\/base-onboarding\/queued-entry\.mjs\b/g, 'rer queue')
 .replace(/(?:\.\/)?scripts\/base-onboarding\//g, `node_modules/${packageName}/onboarding/`)
 .replace(/(?:\.\/)?scripts\/base-cli\//g, `node_modules/${packageName}/`);

const indentOf = text => /\n(\s+)"/.exec(text)?.[1] ?? '  ';
const json = (value, original) => JSON.stringify(value, null, indentOf(original)) + '\n';

export async function toPackage(base, root, { version, log = text => process.stdout.write(text + '\n') } = {}) {
 root = resolve(root);
 let descriptor, descriptorText, pkg;
 const originalPackage = await readFile(join(root, 'package.json'), 'utf8').catch(() => { throw new Refusal(`${root} has no package.json.`, 2); });
 pkg = JSON.parse(originalPackage);
 try { descriptorText = await readFile(join(root, 'OPERATIONS.json'), 'utf8'); descriptor = JSON.parse(descriptorText); } catch { throw new Refusal(`${root} has no readable OPERATIONS.json.`, 2); }
 if (!descriptor.seedContract) throw new Refusal(`${root} is not a first-party seed (its OPERATIONS.json has no seedContract).`, 2);
 const vendored = [];
 for (const path of vendoredPaths) if (await exists(join(root, path))) vendored.push(path);
 if (!vendored.length) {
  if (declaredPackage(pkg)) { log(`${root} already pins ${packageName} ${declaredPackage(pkg)} and carries no vendored copy. To move it to another version: pnpm add -D -E ${packageName}@VERSION.`); return { already: true }; }
  throw new Refusal(`${root} carries no vendored copy (scripts/rer.mjs, scripts/base-cli, scripts/base-onboarding) to convert.`, 2);
 }
 if (vendored.length !== vendoredPaths.length || !await exists(join(root, 'scripts/base-cli/inventory.json'))) throw new Refusal(`${root} carries only part of a vendored copy (${vendored.join(', ')}); restore it with node scripts/export-cli.mjs ${root}, then convert.`, 2);
 if (version !== undefined && !exactVersion.test(version)) throw new Refusal(`--version takes an exact version such as 0.2.0, not ${version}.`, 2);

 log(`Converting ${root} to package mode.`);
 const { edits, baseTests } = await localEdits(base, root);
 if (edits.length) throw new Refusal([
  `Refused: the vendored copy holds ${edits.length} local edit${edits.length === 1 ? '' : 's'} that converting would drop:`,
  ...edits.map(edit => `  ${edit.change.padEnd(7)} ${edit.path}${edit.packagePath ? `  (package file ${edit.packagePath})` : ''}${edit.note ? `  (${edit.note})` : ''}`),
  `Carry each one with pnpm patch ${packageName} once converted, or upstream it to Base; restore the recorded bytes in the vendored copy, then run this again.`,
 ].join('\n'));
 log(`The vendored copy matches its inventory: no local edits.${baseTests.length ? ` ${baseTests.length} Base test source${baseTests.length === 1 ? '' : 's'} beside it (outside the inventory) go with it.` : ''}`);

 const release = await published(root, version);
 log(`Pinning ${packageName} ${release.version}${version ? '' : ' (the latest published version)'}.`);
 const shipped = new Set(await packageFiles(base));
 const known = path => path === '' || path === 'onboarding' || shipped.has(path) || [...shipped].some(file => file.startsWith(path + '/'));
 const exportsMap = JSON.parse(await readFile(join(base, 'global/package.json'), 'utf8')).exports ?? {};

 // Plan every change before writing any.
 const changes = [], unresolved = [], rewritten = new Map();
 const skip = new Set(vendoredPaths);
 for (const file of (await files(root, '', skip)).filter(path => sourceFile.test(path) && !copyChecks.includes(path))) {
  const before = await readFile(join(root, file), 'utf8');
  const launches = testSource(file) ? rewriteTestLaunches(before, file, pkg.scripts) : { text: before, changed: false };
  const after = rewriteSource(launches.text, file, { exportsMap, known, changes });
  if (launches.changed) changes.push({ file, from: 'vendored test launches', to: 'installed rer launcher with foreground dev' });
  if (after !== before) rewritten.set(file, after);
 }
 for (const change of changes.filter(change => change.to.startsWith(packageName + '/') && !exported(release.exports, change.to))) unresolved.push(change);
 if (unresolved.length) throw new Refusal([
  `Refused: ${packageName} ${release.version} does not export what this seed imports:`,
  ...[...new Set(unresolved.map(change => change.to))].map(specifier => `  ${specifier}`),
  `Convert to a version that does (--version X), or upstream the export to Base.`,
 ].join('\n'));

 const scripts = [];
 for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  const next = withoutCopyChecks(packageScript(command));
  if (next !== command) { scripts.push({ name, from: command, to: next || '(removed)' }); if (next) pkg.scripts[name] = next; else delete pkg.scripts[name]; }
 }
 if (pkg.dependencies?.[packageName]) delete pkg.dependencies[packageName];
 pkg.devDependencies = Object.fromEntries(Object.entries({ ...pkg.devDependencies, [packageName]: release.version }).sort(([a], [b]) => a.localeCompare(b)));

 const operations = structuredClone(descriptor), argvChanged = [];
 for (const [verb, command] of Object.entries(operations.commands ?? {})) {
  if (command.argv?.[0] === 'node' && command.argv[1] === 'scripts/rer.mjs') { command.argv = ['rer', ...command.argv.slice(2)]; argvChanged.push(verb); }
  if (Array.isArray(command.inputs)) command.inputs = [...new Set(command.inputs.map(input => packagePath(input) === undefined && !copyChecks.includes(input) ? input : 'package.json'))];
 }

 const calls = await planMetadata(root, json, await planCalls(root, json));

 const markdown = new Map();
 for (const file of (await files(root)).filter(path => path.endsWith('.md'))) {
  const before = calls.get(file) ?? rewritten.get(file) ?? await readFile(join(root, file), 'utf8');
  const after = rewritePackageMarkdown(file, before);
  if (after !== before) {
   if (calls.has(file)) calls.set(file, after);
   else if (rewritten.has(file)) rewritten.set(file, after);
   else markdown.set(file, after);
  }
 }

 let copies, droppedCopies = [];
 const copiesText = await readFile(join(root, 'base-copies.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
 if (copiesText) {
  copies = JSON.parse(copiesText);
  droppedCopies = copies.copies.filter(copy => packagePath(copy.path) !== undefined || copyChecks.includes(copy.path));
  copies.copies = copies.copies.filter(copy => packagePath(copy.path) === undefined && !copyChecks.includes(copy.path));
 }

 // The pin first: when pnpm cannot lock it, nothing else has changed.
 const lockPath = join(root, 'pnpm-lock.yaml'), originalLock = await readFile(lockPath, 'utf8').catch(() => undefined);
 await writeFile(join(root, 'package.json'), json(pkg, originalPackage));
 try { await run('pnpm', ['install', '--lockfile-only'], { cwd: root, env: { ...process.env, CI: 'true' }, maxBuffer: 16 * 1024 * 1024 }); }
 catch (error) {
  await writeFile(join(root, 'package.json'), originalPackage);
  if (originalLock !== undefined) await writeFile(lockPath, originalLock);
  throw new Refusal(`pnpm install --lockfile-only failed, so nothing was converted: ${(error.stderr || error.stdout || error.message).trim().split('\n').slice(-5).join('\n')}`);
 }
 log(`package.json pins ${packageName} ${release.version} in devDependencies; pnpm-lock.yaml locks it.`);

 for (const [file, text] of rewritten) await writeFile(join(root, file), text);
 for (const [file, text] of markdown) await writeFile(join(root, file), text);
 if (changes.length) {
  log(`Rewrote ${changes.length} reference${changes.length === 1 ? '' : 's'} into the vendored copy in ${rewritten.size} file${rewritten.size === 1 ? '' : 's'}:`);
  for (const change of changes) log(`  ${change.file}: ${change.from} -> ${change.to}`);
 }
 if (scripts.length) {
  log('Package scripts:');
  for (const script of scripts) log(`  ${script.name}: ${script.from} -> ${script.to}`);
 }
 await writeFile(join(root, 'OPERATIONS.json'), json(operations, descriptorText));
 if (argvChanged.length) log(`OPERATIONS.json: ${argvChanged.join(', ')} now run rer VERB; inputs on the vendored copy now name package.json.`);
 for (const [file, text] of calls) await writeFile(join(root, file), text);
 if (calls.size) log(`Rewrote command calls and removed tooling selections/globs in: ${[...calls.keys()].join(', ')}. Delivery calls use pnpm exec rer VERB, with a frozen install first where nothing has installed yet.`);
 if (markdown.size) log(`Rewrote package-mode guidance in: ${[...markdown.keys()].join(', ')}.`);
 if (copies && droppedCopies.length) {
  await writeFile(join(root, 'base-copies.json'), json(copies, copiesText));
  log(`base-copies.json: dropped the ${droppedCopies.length} record${droppedCopies.length === 1 ? '' : 's'} of the vendored copy (${droppedCopies.map(copy => copy.path).join(', ')}); its other ${copies.copies.length} records are unchanged.`);
 }
 const counts = [];
 for (const path of copyChecks) if (await exists(join(root,path))) { await rm(join(root,path)); log(`Removed obsolete vendored-copy check ${path}.`); }
 for (const path of vendoredPaths) { counts.push(`${path}${path.endsWith('.mjs') ? '' : ` (${(await files(root, path)).length} files)`}`); await rm(join(root, path), { recursive: true, force: true }); }
 log(`Removed ${counts.join(', ')}.`);

 // What still names the removed files: documentation, records and anything
 // this did not rewrite. A file with many such lines (a lock or a record) is
 // one line here.
 const mentions = [];
 let lines = 0;
 for (const file of (await files(root)).filter(path => textFile.test(path) && path !== 'pnpm-lock.yaml')) {
  const found = (await readFile(join(root, file), 'utf8')).split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => /scripts\/(?:rer\.mjs|base-cli|base-onboarding)/.test(line));
  lines += found.length;
  if (found.length > 3) mentions.push(`  ${file}: ${found.length} lines, from line ${found[0][0]}`);
  else for (const [number, line] of found) mentions.push(`  ${file}:${number}: ${line.trim().slice(0, 160)}`);
 }
 if (mentions.length) log([`${lines} line${lines === 1 ? '' : 's'} in ${new Set(mentions.map(line => line.trim().split(':')[0])).size} files still mention the removed files (documentation, records such as sources.lock.json, or paths built at run time; review them):`, ...mentions].join('\n'));
 log(`Done. Next: pnpm install, then rer check --profile first-party.`);
 return { version: release.version, changes, scripts, argvChanged, calls: [...calls.keys()], droppedCopies: droppedCopies.map(copy => copy.path), mentions: lines };
}
