import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {buildPackage} from '../scripts/rer-package.mjs';
import {checkoutBootstrap} from './contract.mjs';

const base = path.resolve(import.meta.dirname, '..');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
const write = (root, name, value) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), value); };
const init = root => { fs.mkdirSync(root); git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test'); };
const commit = root => { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); };

async function fixture(t) {
 const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rer-authoring-'));
 t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
 const home = path.join(temp, 'home'), packed = path.join(temp, 'packed'), source = path.join(temp, 'source'), seed = path.join(temp, 'seed');
 fs.mkdirSync(home); fs.mkdirSync(packed); init(source); init(seed);
 execFileSync('tar', ['-xzf', await buildPackage(base, path.join(temp, 'build')), '-C', packed]);
 const pkg = path.join(packed, 'package'), version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version;
 const env = {PATH: process.env.PATH, HOME: home, RER_UPDATE_CHECK: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig')};
 // Only the acquisition network edge is redirected; the package's real clone,
 // object reader, copy implementation and public dispatch all execute.
 env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = `url.${source}.insteadOf`; env.GIT_CONFIG_VALUE_0 = 'https://github.com/runeditrun/base.git';
 const run = (...args) => spawnSync(process.execPath, [path.join(pkg, 'global/rer.mjs'), ...args, '--cwd', seed, '--json'], {env, cwd: temp, encoding: 'utf8', timeout: 20000});
 const result = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout.trim().split('\n').at(-1)); };
 const old = (...args) => { const r = spawnSync(process.execPath, [path.join(pkg, 'edition-authoring/cli.mjs'), ...args], {env, cwd: seed, encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
 write(seed, '.gitignore', 'node_modules/\n');
 write(seed, '.node-version', process.versions.node + '\n');
 write(seed, 'package.json', JSON.stringify({engines: {node: process.versions.node}, devDependencies: {'@runeditrun/rer': version}}));
 fs.mkdirSync(path.join(seed, 'node_modules/@runeditrun'), {recursive: true}); fs.symlinkSync(pkg, path.join(seed, 'node_modules/@runeditrun/rer'));
 write(seed, 'rer-project.json', JSON.stringify({schema: 1, projectId: 'example/seed'}));
 write(seed, 'adapter.mjs', 'export const commandAdapter = {verbs: {}};\n');
 write(seed, 'OPERATIONS.json', JSON.stringify({version: 2, project: 'historical/seed', runtime: {requirements: []}, requiredEnvironment: [], seedContract: {version: 1, profile: 'first-party', adapter: 'adapter.mjs'}, commands: {describe: {argv: ['node', 'app.mjs'], inputs: ['app.mjs'], effects: 'Read fixture metadata.'}}}));
 write(seed, 'composition.lock.json', '{"historical":true}\n');
 write(seed, 'app.mjs', 'export const app = true;\n');
 write(source, 'module/one.mjs', 'export const one = 1;\n'); write(source, 'module/two.mjs', 'export const two = 1;\n');
 write(source, 'singleton.mjs', 'export const singleton = true;\n');
 const revision = commit(source);
 fs.cpSync(path.join(source, 'module'), path.join(seed, 'vendor'), {recursive: true});
 fs.copyFileSync(path.join(source, 'singleton.mjs'), path.join(seed, 'one.mjs'));
 old('record-base', 'vendor', 'module', revision, '--base', source);
 old('record-base', 'one.mjs', 'singleton.mjs', revision, '--base', source);
 commit(seed);
 return {seed, source, revision, run, result, old};
}

test('a package-pinned seed adopts authoring and refreshes through the packed public commands', async t => {
 for (const untrackedRecord of [false, true]) {
  const {seed, source, revision, result, old} = await fixture(t);
  if (untrackedRecord) {
   git(seed, 'rm', '--cached', 'base-copies.json');
   fs.chmodSync(path.join(seed, 'base-copies.json'), 0o755);
  }
  const record = fs.readFileSync(path.join(seed, 'base-copies.json')), historical = fs.readFileSync(path.join(seed, 'composition.lock.json'));
  const adopted = result('adopt-edition');
  assert.equal(adopted.adopted, 'example/seed');
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'composition.lock.json')), historical);
  git(seed, 'add', 'edition.json', 'sources.lock.json', 'base-copies.json');
  assert.equal(old('check').ok, true, 'the shipped authoring CLI accepts the adoption lock');
  const description = result('describe');
  // describe returns one document, rather than the event protocol.
  assert.ok(description.verbs['adopt-edition']); assert.ok(description.verbs['refresh-base']);
  assert.equal(checkoutBootstrap(['adopt-edition']), 'before');
  assert.equal(checkoutBootstrap(['refresh-base']), 'before');
  assert.equal(checkoutBootstrap(['adopt-edition', '--help']), 'never');
  fs.rmSync(path.join(seed, 'one.mjs'));
  fs.rmSync(path.join(seed, 'vendor/two.mjs'));
  write(source, 'module/one.mjs', 'export const one = 2;\n');
  const next = commit(source), refreshed = result('refresh-base', '--ref', next);
  assert.deepEqual(refreshed.retired, ['one.mjs']);
  assert.ok(refreshed.copies.find(c => c.path === 'one.mjs').removed.includes('one.mjs'));
  assert.equal(fs.existsSync(path.join(seed, 'one.mjs')), false);
  assert.equal(fs.existsSync(path.join(seed, 'vendor/two.mjs')), false);
  assert.equal(fs.readFileSync(path.join(seed, 'vendor/one.mjs'), 'utf8'), 'export const one = 2;\n');
  assert.equal(old('verify-base', '--base', source).ok, true);
  const after = fs.readFileSync(path.join(seed, 'base-copies.json'));
  assert.deepEqual(result('refresh-base', '--ref', next, '--base', source, '--offline').retired, []);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), after);
  assert.notEqual(revision, next);
 }
});

test('packed authoring preserves source and provenance on invalid adoption and refresh refusal', async t => {
 const {seed, source, revision, run, result, old} = await fixture(t);
 const recordPath = path.join(seed, 'base-copies.json'), record = fs.readFileSync(recordPath), singleton = fs.readFileSync(path.join(seed, 'one.mjs'));
 for (const verb of ['adopt-edition', 'refresh-base']) assert.equal(run(verb, '--help').status, 0);
 assert.equal(run('refresh-base').status, 2);
 assert.equal(run('refresh-base', '--ref', revision, '--offline').status, 4);
 assert.equal(run('refresh-base', '--ref', 'missing', '--base', source).status, 4);
 fs.rmSync(path.join(source, 'singleton.mjs'));
 const next = commit(source);
 assert.equal(run('refresh-base', '--ref', next, '--base', source).status, 4);
 assert.deepEqual(fs.readFileSync(path.join(seed, 'one.mjs')), singleton);
 write(seed, 'one.mjs', 'owner implementation\n');
 assert.equal(run('refresh-base', '--ref', revision, '--base', source).status, 4);
 assert.equal(fs.readFileSync(path.join(seed, 'one.mjs'), 'utf8'), 'owner implementation\n');
 assert.deepEqual(fs.readFileSync(recordPath), record);
 old('adapt-base', 'one.mjs');
 fs.rmSync(path.join(seed, 'one.mjs'));
 const adapted = fs.readFileSync(recordPath);
 assert.equal(run('refresh-base', '--ref', revision, '--base', source).status, 4);
 assert.deepEqual(fs.readFileSync(recordPath), adapted);
 // No-record adoption still creates a lock valid after the new inputs are staged.
 fs.rmSync(recordPath); git(seed, 'rm', '--cached', 'one.mjs', 'base-copies.json');
 result('adopt-edition'); git(seed, 'add', 'edition.json', 'sources.lock.json', 'base-copies.json');
 assert.equal(old('check').ok, true);
 const recipe = fs.readFileSync(path.join(seed, 'edition.json'));
 assert.equal(run('adopt-edition').status, 4);
 assert.deepEqual(fs.readFileSync(path.join(seed, 'edition.json')), recipe);
});

test('packed refresh delivers and adopts templates with their helpers atomically', async t => {
 const {seed, source, old, result, run} = await fixture(t);
 const workflow = '.github/workflows/custom.yml';
 for (const origin of ['export/custom.yml', 'default-seed/.github/workflows/custom.yml']) {
  write(source, origin, 'jobs:\n  check:\n    steps:\n      - run: echo before\n');
  const pin = commit(source);
  write(seed, workflow, fs.readFileSync(path.join(source, origin)));
  old('record-base', workflow, origin, pin, '--base', source);
  commit(seed);
  // Neither helper name is special to the implementation. Cache-only and
  // commented script names must not become dependencies.
  write(source, origin, 'jobs:\n  check:\n    steps:\n      - run: |\n          # python3 scripts/comment.py\n          sudo env X=yes python3 scripts/new-helper.py\n          node scripts/another-helper.mjs\n          env -u X node scripts/env.mjs\n          sudo -u nobody node scripts/sudo.mjs\n          node --import scripts/bootstrap.mjs scripts/entry.mjs\n          node \"scripts/with space.mjs\"\n          bash -c \'node scripts/shell.mjs\'\n          echo $(node scripts/substitution.mjs)\n          echo scripts/not-invoked.py\n      - uses: actions/cache@v4\n        with:\n          path: scripts/cache-only.py\n');
  write(source, 'default-seed/scripts/new-helper.py', 'print("workflow helper")\n');
  write(source, 'export/new-helper.py', 'print("workflow helper")\n');
  write(source, 'default-seed/scripts/another-helper.mjs', 'console.log("second helper");\n');
  for (const name of ['env', 'sudo', 'bootstrap', 'entry', 'with space', 'shell', 'substitution']) {
   for (const prefix of ['export', 'default-seed/scripts']) write(source, `${prefix}/${name}.mjs`, 'export {leaf} from \"./leaf.mjs\";\n');
  }
  for (const prefix of ['export', 'default-seed/scripts']) write(source, `${prefix}/leaf.mjs`, 'export const leaf = true;\n');
  const next = commit(source);
  const before = fs.readFileSync(path.join(seed, workflow)), record = fs.readFileSync(path.join(seed, 'base-copies.json'));
  write(seed, 'scripts/new-helper.py', 'print("workflow helper")\n');
  assert.equal(run('refresh-base', '--ref', next, '--base', source).status, 4, 'untracked equality cannot transfer ownership');
  assert.deepEqual(fs.readFileSync(path.join(seed, workflow)), before);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
  fs.rmSync(path.join(seed, 'scripts/new-helper.py'));
  execFileSync('mkfifo', [path.join(seed, 'scripts/new-helper.py')]);
  assert.equal(run('refresh-base', '--ref', next, '--base', source).status, 4);
  assert.deepEqual(fs.readFileSync(path.join(seed, workflow)), before);
  fs.rmSync(path.join(seed, 'scripts/new-helper.py'));
  result('refresh-base', '--ref', next, '--base', source);
  for (const name of ['new-helper.py', 'another-helper.mjs']) assert.ok(fs.existsSync(path.join(seed, 'scripts', name)));
  for (const name of ['env', 'sudo', 'bootstrap', 'entry', 'with space', 'shell', 'substitution', 'leaf']) assert.ok(fs.existsSync(path.join(seed, `scripts/${name}.mjs`)));
  assert.equal(old('verify-base', '--base', source).ok, true);
  const after = fs.readFileSync(path.join(seed, 'base-copies.json'));
  result('refresh-base', '--ref', next, '--base', source, '--offline');
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), after);
  // Remove this iteration's helper records to exercise both origin layouts.
  const copies = JSON.parse(after); copies.copies = copies.copies.filter(copy => !copy.path.startsWith('scripts/'));
  write(seed, 'base-copies.json', JSON.stringify(copies));
  fs.rmSync(path.join(seed, 'scripts'), {recursive: true});
  git(seed, 'add', '-A');
 }


 for (const historyRoot of ['export', 'default-seed']) {
 for (const ownership of ['tracked', 'diverged', 'untracked', 'ignored', 'adapted']) {
  const {seed, source, old, result} = await fixture(t);
  const workflow = '.github/workflows/verify.yml', guide = 'VERIFY-WORKFLOW.md';
  const historical = 'jobs:\n  check:\n    runs-on: ubuntu-24.04\n    env:\n      PLAYWRIGHT_BROWSERS_PATH: ${{ runner.temp }}/ms-playwright\n    steps:\n      - run: echo old\n';
  const origin = historyRoot === 'export' ? 'export/verify.yml' : 'default-seed/' + workflow;
  const guideOrigin = historyRoot + '/' + guide;
  write(source, origin, historical);
  write(source, guideOrigin, 'Historical workflow guide with enough bytes.\n');
  const pin = commit(source);
  for (const [target, sourcePath] of [[workflow, origin], [guide, guideOrigin]]) write(seed, target, fs.readFileSync(path.join(source, sourcePath)));
  if (ownership === 'diverged') write(seed, workflow, historical + '# product adaptation\n');
  if (ownership === 'ignored') write(seed, '.gitignore', 'node_modules/\n.github/\nVERIFY-WORKFLOW.md\n');
  if (['tracked', 'diverged', 'adapted'].includes(ownership)) commit(seed);
  if (ownership === 'adapted') {
   old('record-base', workflow, origin, pin, '--base', source);
   old('adapt-base', workflow);
  }
  const before = fs.readFileSync(path.join(seed, workflow));
  const current = 'jobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: python3 scripts/future-helper.py\n';
  write(source, 'export/verify.yml', current);
  write(source, 'export/VERIFY-WORKFLOW.md', 'Current workflow guide with enough bytes.\n');
  write(source, 'export/future-helper.py', 'print("new dependency")\n');
  const next = commit(source);
  const refreshed = result('refresh-base', '--ref', next, '--base', source);
  if (ownership === 'tracked') {
   assert.equal(fs.readFileSync(path.join(seed, workflow), 'utf8'), current);
   assert.equal(refreshed.templateAdoptions.find(item => item.path === workflow).from, pin);
   assert.equal(fs.readFileSync(path.join(seed, guide), 'utf8'), 'Current workflow guide with enough bytes.\n');
   assert.ok(fs.existsSync(path.join(seed, 'scripts/future-helper.py')));
  } else {
   assert.deepEqual(fs.readFileSync(path.join(seed, workflow)), before);
   assert.equal(refreshed.notices.length, 1);
   assert.ok(refreshed.notices[0].includes(workflow));
   assert.ok(refreshed.notices[0].includes('record-base'));
   assert.equal(fs.existsSync(path.join(seed, 'scripts/future-helper.py')), false);
  }
  const after = fs.readFileSync(path.join(seed, 'base-copies.json'));
  result('refresh-base', '--ref', next, '--base', source, '--offline');
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), after);
 }
 }
 for (const alias of ['adoption', 'recorded', 'helper', 'namespace']) {
  const {seed, source, old, result, run} = await fixture(t);
  const workflow = '.github/workflows/verify.yml';
  const original = 'jobs:\n  check:\n    steps:\n      - run: node scripts/helper.mjs\n';
  write(source, 'export/verify.yml', original);
  write(source, 'export/helper.mjs', 'export const helper = true;\n');
  write(source, '.github/workflows/verify.yml', 'root CI must never ship\n');
  const pin = commit(source);
  old('record-base', 'vendor', 'module', pin, '--base', source);
  old('record-base', 'one.mjs', 'singleton.mjs', pin, '--base', source);
  if (alias === 'namespace') {
   write(source, 'export/caller.yml', 'jobs:\n  check:\n    uses: ./.github/workflows/verify.yml\n');
   const next = commit(source);
   write(seed, '.github/workflows/caller.yml', fs.readFileSync(path.join(source, 'export/caller.yml')));
   old('record-base', '.github/workflows/caller.yml', 'export/caller.yml', next, '--base', source);
   result('refresh-base', '--ref', next, '--base', source);
   assert.equal(fs.readFileSync(path.join(seed, workflow), 'utf8'), original);
   continue;
  }
  write(seed, workflow, original);
  if (alias === 'helper') write(seed, 'scripts/helper.mjs', 'export const helper = "seed-owned";\n');
  commit(seed);
  if (alias !== 'adoption') old('record-base', workflow, 'export/verify.yml', pin, '--base', source);
  const target = alias === 'helper' ? 'scripts/helper.mjs' : workflow;
  const renamed = path.join(path.dirname(target), path.basename(target).toUpperCase());
  fs.renameSync(path.join(seed, target), path.join(seed, target + '.middle'));
  fs.renameSync(path.join(seed, target + '.middle'), path.join(seed, renamed));
  if (!fs.existsSync(path.join(seed, target))) continue; // Case-sensitive volume.
  const before = fs.readFileSync(path.join(seed, renamed)), record = fs.readFileSync(path.join(seed, 'base-copies.json'));
  const refreshed = run('refresh-base', '--ref', pin, '--base', source);
  assert.equal(refreshed.status, alias === 'adoption' ? 0 : 4, refreshed.stdout + refreshed.stderr);
  assert.deepEqual(fs.readFileSync(path.join(seed, renamed)), before);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
  if (alias === 'adoption') assert.equal(JSON.parse(refreshed.stdout.trim().split('\n').at(-1)).notices.length, 1);
 }

});
