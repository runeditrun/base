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
 const {seed, source, revision, result, old} = await fixture(t);
 const record = fs.readFileSync(path.join(seed, 'base-copies.json')), historical = fs.readFileSync(path.join(seed, 'composition.lock.json'));
 const adopted = result('adopt-edition');
 assert.equal(adopted.adopted, 'example/seed');
 assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
 assert.deepEqual(fs.readFileSync(path.join(seed, 'composition.lock.json')), historical);
 git(seed, 'add', 'edition.json', 'sources.lock.json');
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
