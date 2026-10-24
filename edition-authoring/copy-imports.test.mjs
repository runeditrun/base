import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

const cli = path.join(import.meta.dirname, 'cli.mjs');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
const write = (root, name, bytes) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), bytes); };
const commit = root => { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-imports-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const base = path.join(temp, 'base'), seed = path.join(temp, 'seed');
  for (const root of [base, seed]) {
    fs.mkdirSync(root); git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
  }
  write(base, 'tools/main.mjs', "console.log('original');\n");
  write(seed, 'scripts/main.mjs', fs.readFileSync(path.join(base, 'tools/main.mjs')));
  const revision = commit(base);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--base', base], {cwd: seed, encoding: 'utf8'});
  assert.equal(run('record-base', 'scripts/main.mjs', 'tools/main.mjs', revision).status, 0);
  commit(seed);
  return {base, seed, run};
}

test('per-file refresh records a transitive runnable module set and repeats without drift', t => {
  const {base, seed, run} = fixture(t);
  write(base, 'tools/main.mjs', "import './side.mjs'; import {value} from './lib/helper.mjs'; console.log(value);\n");
  write(base, 'tools/lib/helper.mjs', "export {value} from './value.mjs';\n");
  write(base, 'tools/lib/value.mjs', 'export const value = 42;\n');
  write(base, 'tools/side.mjs', 'globalThis.authoringReady = true;\n');
  const revision = commit(base), refresh = run('refresh-base', revision);
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.equal(JSON.parse(refresh.stdout).adopted.length, 3);
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), '42');
  assert.equal(run('verify-base').status, 0);
  const record = fs.readFileSync(path.join(seed, 'base-copies.json'));
  assert.equal(run('refresh-base', revision).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
});

test('unresolvable relative imports refuse the entire refresh before source or record writes', t => {
  const {base, seed, run} = fixture(t);
  const original = fs.readFileSync(path.join(seed, 'scripts/main.mjs'));
  const record = fs.readFileSync(path.join(seed, 'base-copies.json'));
  write(base, 'tools/main.mjs', "import {missing} from './missing.mjs'; import {outside} from '../outside.mjs'; console.log(missing, outside);\n");
  write(base, 'outside.mjs', 'export const outside = true;\n');
  const revision = commit(base), refused = run('refresh-base', revision);
  assert.equal(refused.status, 1);
  for (const [name, origin] of [['scripts/missing.mjs', 'tools/missing.mjs'], ['outside.mjs', 'outside.mjs']]) {
    assert.ok(refused.stderr.includes(`record-base '${name}' '${origin}' ${revision}`), refused.stderr);
  }
  assert.deepEqual(fs.readFileSync(path.join(seed, 'scripts/main.mjs')), original);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
  assert.equal(fs.existsSync(path.join(seed, 'outside.mjs')), false);
});
