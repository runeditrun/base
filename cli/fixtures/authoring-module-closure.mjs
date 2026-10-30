import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {testSource} from '../../edition-authoring/files.mjs';

const message = run => run.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'error')?.message;
function snapshot(root) {
 const files = {};
 function visit(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
   if (!prefix && ['.git', 'node_modules'].includes(entry.name)) continue;
   const name = prefix + entry.name, absolute = path.join(directory, entry.name);
   files[name] = {mode: fs.lstatSync(absolute).mode, ...(entry.isFile() ? {bytes: fs.readFileSync(absolute).toString('hex')} : {})};
   if (entry.isDirectory()) visit(absolute, name + '/');
  }
 }
 visit(root); return files;
}

export async function retainedRecovery(t, {fixture, write, commit, base}) {
 const {seed, source, old, run, result, env} = await fixture(t);
 const origin = 'modules/portability', target = 'src/modules/portability';
 const importer = `${target}/http.mjs`, retained = `${target}/import.mjs`;
 const original = 'export const seedLabel = "Base";\n\nexport const existing = true;\n';
 write(source, `${origin}/http.mjs`, 'export const http = true;\n');
 write(source, `${origin}/import.mjs`, original);
 const pin = commit(source);
 write(seed, importer, 'export const http = true;\n');
 write(seed, retained, original.replace('"Base"', '"Mango"'));
 old('record-base', importer, `${origin}/http.mjs`, pin, '--base', source);
 commit(seed);
 write(source, 'package.json', JSON.stringify({dependencies: {'fixture-first': '1.2.3', 'fixture-second': '4.5.6'}}));
 write(source, `${origin}/http.mjs`, `import {one, two} from './import.mjs';\nimport {three} from './legacy-safety.mjs';\nimport first from 'fixture-first';\nimport second from 'fixture-second/subpath';\nexport const http = [one, two, three, first, second];\n`);
 write(source, `${origin}/import.mjs`, original + "export {one, two} from './library-history.mjs';\n");
 write(source, `${origin}/library-history.mjs`, 'export const one = 1, two = 2;\n');
 // Same lexical shape as legacy-safety.mjs: quote characters in a regex precede
 // real exports. It must stay a seed-owned, unrecorded module.
 write(source, `${origin}/legacy-safety.mjs`, 'export const three = 3;\n');
 const regexSource = fs.readFileSync(path.join(base, 'modules/portability/legacy-safety.mjs'), 'utf8');
 write(seed, `${target}/legacy-safety.mjs`, regexSource + '\nexport const three = 3;\n');
 commit(seed);
 const next = commit(source), before = snapshot(seed);
 const refused = run('refresh-base', '--ref', next, '--base', source);
 assert.equal(refused.status, 4, refused.stdout + refused.stderr);
 assert.deepEqual(snapshot(seed), before, 'export and package refusals write nothing');
 const error = message(refused);
 for (const name of ['one', 'two']) assert.ok(error.includes(`does not export ${name}`), error);
 for (const name of ['fixture-first', 'fixture-second']) assert.ok(error.includes(`package ${name}`), error);
 assert.ok(error.includes('1.2.3') && error.includes('4.5.6'), error);
 assert.ok(!error.includes('does not export three'), error);
 t.diagnostic('PROBE A aggregate: packed rer refresh-base -> exit 4, 2 missing exports + 2 missing packages, unchanged tree');
 function shell(command) {
  const r = spawnSync('sh', ['-c', command], {cwd: seed, env, encoding: 'utf8'});
  assert.equal(r.status, 0, command + '\n' + r.stdout + r.stderr);
 }
 // Execute the printed recovery order, including the real three-way merge.
 const commands = error.split('\n');
 for (const command of commands.filter(line => line.startsWith('cp ') || line.startsWith('git -C ') || line.startsWith('node ') && line.includes(' record-base '))) shell(command);
 const manifest = JSON.parse(fs.readFileSync(path.join(seed, 'package.json')));
 // Declaring packages is seed-owned; no install is needed to plan file copies.
 manifest.dependencies = {'fixture-first': '1.2.3', 'fixture-second': '4.5.6'};
 write(seed, 'package.json', JSON.stringify(manifest));
 const refreshed = result('refresh-base', '--ref', next, '--base', source);
 assert.ok(refreshed.copies.flatMap(copy => copy.added).includes(`${target}/library-history.mjs`));
 shell(commands.find(line => line.startsWith('git merge-file ')));
 shell(commands.find(line => line.startsWith('node ') && line.includes(' adapt-base ')));
 const repeat = result('refresh-base', '--ref', next, '--base', source);
 assert.deepEqual(repeat.copies.flatMap(copy => copy.added), []);
 assert.match(fs.readFileSync(path.join(seed, retained), 'utf8'), /Mango/);
 const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `import {one, two, seedLabel} from './${retained}'; if(one !== 1 || two !== 2 || seedLabel !== 'Mango') process.exit(1);`], {cwd: seed, env, encoding: 'utf8'});
 assert.equal(loaded.status, 0, loaded.stderr);
 for (const suffix of ['.base', '.ancestor', '.seed']) fs.rmSync(path.join(seed, retained + suffix));
 assert.equal(old('verify-base', '--base', source).ok, true);
 t.diagnostic('PROBE B recovery: record-base -> declare packages -> refresh -> merge-file -> adapt-base -> refresh: exit 0, 0 added, retained seed edit loads');
 t.diagnostic('PROBE C regex: retained legacy-safety.mjs with quote-bearing regex -> refresh exit 0, true export accepted');
 write(source, `${origin}/http.mjs`, "import {missing} from './legacy-safety.mjs';\nexport const http = missing;\n");
 const negativeBefore = snapshot(seed), negative = run('refresh-base', '--ref', commit(source), '--base', source);
 assert.equal(negative.status, 4, negative.stdout + negative.stderr);
 assert.match(message(negative), /does not export missing/);
 assert.deepEqual(snapshot(seed), negativeBefore);
 t.diagnostic('PROBE E negative: real absent export -> exit 4, unchanged tree');
}

export async function deployKitRefresh(t, {fixture, write, commit, base}) {
 const {seed, source, old, result} = await fixture(t);
 // Penny's separate copies establish the modules namespace, without granting
 // the CLI or edition-authoring trees a destination below base/.
 const selections = ['modules/deploy-kit', 'modules/portability', 'modules/dependencies', 'modules/operator-auth', 'operations'];
 for (const name of [...selections, 'cli', 'edition-authoring']) fs.cpSync(path.join(base, name), path.join(source, name), {recursive: true});
 for (const name of ['prepare.mjs', 'templates.mjs']) write(source, `modules/deploy-kit/${name}`, 'export const before = true;\n');
 const pin = commit(source);
 for (const name of selections) {
  fs.cpSync(path.join(source, name), path.join(seed, 'base', name), {recursive: true, filter: filename => !testSource(path.relative(source, filename))});
  old('record-base', 'base/' + name, name, pin, '--base', source);
 }
 commit(seed);
 for (const name of ['prepare.mjs', 'templates.mjs']) fs.copyFileSync(path.join(base, 'modules/deploy-kit', name), path.join(source, 'modules/deploy-kit', name));
 const next = commit(source), refreshed = result('refresh-base', '--ref', next, '--base', source);
 assert.equal(refreshed.refreshed, next);
 assert.deepEqual(result('refresh-base', '--ref', next, '--base', source).copies.flatMap(copy => copy.added), []);
 const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./base/modules/deploy-kit/prepare.mjs'); await import('./base/modules/deploy-kit/templates.mjs');"], {cwd: seed, encoding: 'utf8'});
 assert.equal(loaded.status, 0, loaded.stderr);
 assert.equal(fs.existsSync(path.join(seed, 'base/cli')), false);
 assert.equal(fs.existsSync(path.join(seed, 'base/edition-authoring')), false);
 t.diagnostic('PROBE D deploy-kit: packed rer refresh-base on Penny-shaped copies -> exit 0; prepare and templates load without CLI/authoring copies; repeat 0 added');
}
