import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real public seeds with legacy tool records, never synthetic applications.
const seeds = [
 ['https://github.com/just-every/run-pegboard.git', 'c5a6a20c693e148ae48ea9be76dad2741104de99'],
 ['https://github.com/just-every/run-pencil.git', '9b73eadf84a0b626d2161a20c7d68e010342f90e'],
 ['https://github.com/just-every/run-dial.git', 'f804f213b7d43535035c4d75e540569939d8ad31'],
 ['https://github.com/just-every/run-placemat.git', 'dd414c1cddf09159e75d6c49f126b9b23ee766ad'],
 ['https://github.com/just-every/run-envelope.git', '272ccc966a2b8e2281017c86d48c988717913db7'],
];

function authoringImports(seed, local, specifiers) {
 const directory = dirname(local);
 return readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
   const filename = join(directory, entry.name);
   const imports = specifiers(readFileSync(filename, 'utf8')).map(specifier => {
    const target = fileURLToPath(new URL(specifier, pathToFileURL(filename)));
    assert.ok(lstatSync(target).isFile(), `${filename}: ${specifier} must resolve to a regular file`);
    return specifier;
   });
   return { path: filename.slice(seed.length + 1), imports };
  });
}

export async function refreshSmoke({ root, installed, base, ref, run, output }) {
 const cli = join(installed, 'edition-authoring/cli.mjs');
 const { specifiers } = await import(pathToFileURL(join(installed, 'edition-authoring/runtime-dependencies.mjs')));
 return seeds.map(([seedRepository, seedRevision]) => {
  const name = new URL(seedRepository).pathname.split('/').at(-1).slice('run-'.length, -'.git'.length);
  const seed = join(root, name);
  run('git', ['init', '--quiet', seed]);
  run('git', ['-C', seed, 'fetch', '--quiet', '--depth=1', seedRepository, seedRevision]);
  run('git', ['-C', seed, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const recordPath = join(seed, 'base-copies.json');
  const before = JSON.parse(readFileSync(recordPath));
  const refreshed = JSON.parse(run(process.execPath, [cli, 'refresh-base', ref, '--base', base], { cwd: seed }));
  assert.equal(refreshed.refreshed, ref);
  const recordBytes = readFileSync(recordPath);
  const record = JSON.parse(recordBytes);
  writeFileSync(join(output, `${name}-base-copies.json`), recordBytes);
  // Inspect every direct authoring module, rather than naming or counting
  // helpers: newly introduced dependencies must stay covered by this gate.
  const local = join(seed, 'scripts/edition-authoring/cli.mjs');
  const modules = authoringImports(seed, local, specifiers);
  const verified = JSON.parse(run(process.execPath, [local, 'verify-base', '--base', base], { cwd: seed }));
  const packaged = JSON.parse(run(process.execPath, [cli, 'verify-base', '--base', base], { cwd: seed }));
  for (const result of [verified, packaged]) {
   assert.equal(result.ok, true); assert.deepEqual(result.drift, []); assert.deepEqual(result.unrecordedCopies, []);
  }
  // Repeat from the same installed entry; source records must be byte-stable.
  run(process.execPath, [cli, 'refresh-base', ref, '--base', base], { cwd: seed });
  assert.deepEqual(readFileSync(recordPath), recordBytes);
  return { seed: name, seedRepository, seedRevision, before: before.copies.length, after: record.copies.length,
   refreshed: refreshed.refreshed, modules, localVerify: verified.ok, packageVerify: packaged.ok,
   drift: verified.drift, unrecordedCopies: verified.unrecordedCopies, repeat: true };
 });
}
