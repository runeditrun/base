import assert from 'node:assert/strict';
import {lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Real public seeds with legacy tool records, never synthetic applications.
const seeds = [
 ['https://github.com/just-every/run-pegboard.git', 'c5a6a20c693e148ae48ea9be76dad2741104de99'],
 ['https://github.com/just-every/run-pencil.git', '9b73eadf84a0b626d2161a20c7d68e010342f90e'],
 ['https://github.com/just-every/run-dial.git', 'f804f213b7d43535035c4d75e540569939d8ad31'],
 ['https://github.com/just-every/run-placemat.git', 'dd414c1cddf09159e75d6c49f126b9b23ee766ad'],
 ['https://github.com/just-every/run-envelope.git', '272ccc966a2b8e2281017c86d48c988717913db7'],
];
function snapshot(root) {
 const files = {};
 function walk(directory, prefix = '') {
  for (const name of readdirSync(directory).sort()) {
   if (!prefix && name === '.git') continue;
   const relative = prefix ? prefix + '/' + name : name, absolute = join(directory, name), stat = lstatSync(absolute);
   files[relative] = {mode: stat.mode, ...(stat.isFile() ? {bytes: readFileSync(absolute).toString('base64')} : stat.isSymbolicLink() ? {link: readlinkSync(absolute)} : {})};
   if (stat.isDirectory()) walk(absolute, relative);
  }
 }
 walk(root); return files;
}
function imports(seed, record, specifiers, resolve) {
 const disk = {has: name => { try { return lstatSync(join(seed, name)).isFile(); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; } }};
 return record.copies.flatMap(copy => Object.keys(copy.files)).filter(name => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) && disk.has(name))
  .flatMap(name => specifiers(readFileSync(join(seed, name), 'utf8')).map(specifier => ({path: name, specifier, target: resolve(disk, name, specifier)})));
}
export async function refreshSmoke({root, installed, base, ref, run, output}) {
 const cli = join(installed, 'edition-authoring/cli.mjs');
 const {specifiers, resolve} = await import(pathToFileURL(join(installed, 'edition-authoring/runtime-dependencies.mjs')));
 const data = JSON.parse(run('git', ['-C', base, 'show', `${ref}:foundation/edition-migrations.json`]));
 const consent = data.migrations.flatMap(step => ['--edition-migration', step.id]);
 return seeds.map(([seedRepository, seedRevision]) => {
  const name = new URL(seedRepository).pathname.split('/').at(-1).slice('run-'.length, -'.git'.length), seed = join(root, name);
  run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', seedRepository, seed]);
  run('git', ['-C', seed, 'checkout', '--quiet', '--detach', seedRevision]);
  const recordPath = join(seed, 'base-copies.json');
  const record = () => JSON.parse(readFileSync(recordPath));
  const unresolved = new Set(imports(seed, record(), specifiers, resolve).filter(edge => !edge.target).map(edge => edge.path + '\0' + edge.specifier));
  const attempts = [];
  for (const flags of [[], consent]) {
   const before = snapshot(seed);
   let refreshed;
   try { refreshed = JSON.parse(run(process.execPath, [cli, 'refresh-base', ref, '--base', base, ...flags], {cwd: seed})); }
   catch (error) {
    assert.ok(Number.isInteger(error.cause?.status) && error.cause.status !== 0, 'only a CLI refusal can satisfy the refusal invariant');
    assert.deepEqual(snapshot(seed), before, 'refusal must preserve the entire tree and record');
    attempts.push({consent: flags.length > 0, refused: true, exit: error.cause.status, error: error.message});
    continue;
   }
   const modules = imports(seed, record(), specifiers, resolve);
   for (const edge of modules) assert.ok(edge.target || unresolved.has(edge.path + '\0' + edge.specifier), `${edge.path}: new unresolved relative import ${edge.specifier}`);
   const local = join(seed, 'scripts/edition-authoring/cli.mjs');
   for (const entry of [local, cli]) {
    const verified = JSON.parse(run(process.execPath, [entry, 'verify-base', '--base', base], {cwd: seed}));
    assert.equal(verified.ok, true); assert.deepEqual(verified.drift, []); assert.deepEqual(verified.unrecordedCopies, []);
    run(process.execPath, [entry, 'lock'], {cwd: seed});
   }
   const stable = snapshot(seed);
   run(process.execPath, [cli, 'refresh-base', ref, '--base', base], {cwd: seed});
   assert.deepEqual(snapshot(seed), stable, 'repeat must preserve the entire tree and record');
   attempts.push({consent: flags.length > 0, refreshed: refreshed.refreshed, modules, repeat: true});
  }
  writeFileSync(join(output, `${name}-base-copies.json`), readFileSync(recordPath));
  return {seed: name, seedRepository, seedRevision, attempts};
 });
}
