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
  const refresh = revision => spawnSync(process.execPath, [path.join(import.meta.dirname, '../global/rer.mjs'), 'refresh-base', '--ref', revision, '--base', base, '--json'], {cwd: seed, encoding: 'utf8'});
  return {base, seed, run, refresh};
}

test('per-file refresh records a transitive runnable module set and repeats without drift', t => {
  const {base, seed, run} = fixture(t);
  // Lexical traps around real imports: postfix operators before a slash, a regular expression and nested templates holding import text.
  write(base, 'tools/main.mjs', "let n = 2; n++ / 2; if (n) /import '.\\/ghost.mjs'/.test('x');\nconst text = `outer ${`inner import './ghost.mjs'`}`;\nimport './side.mjs'; import {value} from './lib/helper.mjs'; console.log(value, text.length > 0);\n");
  write(base, 'tools/lib/helper.mjs', "export {value} from './value.mjs';\n");
  write(base, 'tools/lib/value.mjs', 'export const value = 42;\n');
  write(base, 'tools/side.mjs', 'globalThis.authoringReady = true;\n');
  const revision = commit(base), refresh = run('refresh-base', revision);
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.equal(JSON.parse(refresh.stdout).adopted.length, 3);
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), '42 true');
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

test('public refresh parses nested superclasses and ASI without inventing regex imports', t => {
  const {base, seed, refresh} = fixture(t);
  write(base, 'tools/main.mjs', String.raw`const c = class extends class {} {} / 1; import '.\x2fasi.mjs'; /x/;
`);
  write(base, 'tools/asi.mjs', String.raw`const async = 7; const a = async
function f() {}
/; import '.\x2fghost.mjs'/ / 1;
debugger
/; import '.\x2fghost.mjs'/ / 1; import './real.mjs'; console.log(a);
`);
  write(base, 'tools/real.mjs', 'export const real = 42;\n');
  const result = refresh(commit(base));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).adopted.map(item => item.path), ['scripts/asi.mjs', 'scripts/real.mjs']);
  assert.equal(fs.existsSync(path.join(seed, 'scripts/ghost.mjs')), false);
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), '7');
});

test('public refresh refuses an unparsable transitive helper before writing any files', t => {
  const {base, seed, refresh} = fixture(t);
  const before = git(seed, 'status', '--porcelain=v1', '-uall');
  const original = fs.readFileSync(path.join(seed, 'scripts/main.mjs'));
  const record = fs.readFileSync(path.join(seed, 'base-copies.json'));
  write(base, 'tools/main.mjs', "import './ok.mjs'; import './bad.mjs';\n");
  // These top-level effects must never run while discovering module requests.
  write(base, 'tools/ok.mjs', "throw new Error('must only parse'); import './child.mjs';\n");
  write(base, 'tools/child.mjs', 'export const child = true;\n');
  write(base, 'tools/bad.mjs', 'export const = 1;\n');
  const refused = refresh(commit(base));
  assert.notEqual(refused.status, 0);
  assert.ok((refused.stderr + refused.stdout).includes('scripts/bad.mjs'), refused.stderr + refused.stdout);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'scripts/main.mjs')), original);
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
  for (const name of ['ok', 'bad', 'child']) assert.equal(fs.existsSync(path.join(seed, `scripts/${name}.mjs`)), false);
  assert.equal(git(seed, 'status', '--porcelain=v1', '-uall'), before);
});

test('public refresh follows extensionless ESM through the committed origin package scope', t => {
  const {base, seed, refresh} = fixture(t);
  for (const root of [base, seed]) write(root, 'package.json', '{"type":"module"}\n');
  write(base, 'tools/main.mjs', "import './helper'; console.log('complete');\n");
  write(base, 'tools/helper', "import './leaf';\n");
  write(base, 'tools/leaf', "console.log('leaf');\n");
  const revision = commit(base);
  write(base, 'package.json', '{"type":"commonjs"}\n');
  const result = refresh(revision);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).adopted.map(item => item.path), ['scripts/helper', 'scripts/leaf']);
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, 'leaf\ncomplete\n');
});

test('public refresh accepts valid CommonJS wrapper bodies inside a module package', t => {
  const {base, seed, refresh} = fixture(t);
  for (const root of [base, seed]) write(root, 'package.json', '{"type":"module"}\n');
  write(base, 'tools/main.mjs', "import './return.cjs'; import './with.cjs'; import './duplicate.cjs';\n");
  write(base, 'tools/return.cjs', "if (false) return; module.exports=2; console.log('cjs');\n");
  write(base, 'tools/with.cjs', "with ({a:2}) console.log(a); module.exports=2;\n");
  write(base, 'tools/duplicate.cjs', "function f(a,a){return a}; console.log(f(1,2));\n");
  const result = refresh(commit(base));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, 'cjs\n2\n2\n');
});


test('public refresh copies ordinary documents and data without parsing them as JavaScript', t => {
  const {base, seed, run, refresh} = fixture(t);
  fs.rmSync(path.join(seed, 'base-copies.json'));
  const original = git(base, 'rev-parse', 'HEAD');
  assert.equal(run('record-base', 'scripts', 'tools', original).status, 0);
  const files = {'.node-version': '22.20.0\n', LICENSE: 'A licence is not a JavaScript program.\n', '.gitignore': '*.cache\n', 'values.json': '{"n":42}\n', 'image.wasm': Buffer.from([0, 97, 115, 109]), 'notes.unknown': 'ordinary data with no entry point\n'};
  for (const [name, bytes] of Object.entries(files)) write(base, 'tools/' + name, bytes);
  write(base, 'tools/main.mjs', "import './helper'; console.log('ready');\n");
  write(base, 'tools/helper', "import './leaf.mjs';\n");
  write(base, 'tools/leaf.mjs', "console.log('leaf');\n");
  write(base, 'package.json', '{"type":"module"}\n');
  write(seed, 'package.json', '{"type":"module","private":true}\n');
  const result = refresh(commit(base));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(seed, 'scripts', name)), Buffer.from(bytes));
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, 'leaf\nready\n');
  const verification = run('verify-base');
  assert.equal(verification.status, 0, verification.stdout + verification.stderr);
});

test('public refresh preserves a satisfied seed-owned dependency and follows its actual imports', t => {
  const {base, seed, run, refresh} = fixture(t);
  const owned = "import './local.mjs'; export const value = 19;\n";
  write(seed, 'scripts/helper.mjs', owned);
  write(seed, 'scripts/local.mjs', 'export const local = true;\n');
  write(base, 'tools/main.mjs', "import {value} from './helper.mjs'; console.log(value);\n");
  write(base, 'tools/helper.mjs', "import './upstream-only.mjs'; export const value = 2;\n");
  write(base, 'tools/upstream-only.mjs', "throw new Error('not the adopted dependency');\n");
  const revision = commit(base), result = refresh(revision);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(seed, 'scripts/helper.mjs'), 'utf8'), owned);
  assert.equal(fs.existsSync(path.join(seed, 'scripts/upstream-only.mjs')), false);
  const execution = spawnSync(process.execPath, ['scripts/main.mjs'], {cwd: seed, encoding: 'utf8'});
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, '19\n');
  assert.equal(run('verify-base').status, 0);
  const record = fs.readFileSync(path.join(seed, 'base-copies.json'));
  fs.rmSync(path.join(seed, 'scripts/local.mjs'));
  const refused = refresh(revision);
  assert.notEqual(refused.status, 0);
  assert.ok((refused.stdout + refused.stderr).includes(`record-base 'scripts/local.mjs' 'tools/local.mjs' ${revision}`));
  assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
  assert.equal(fs.readFileSync(path.join(seed, 'scripts/helper.mjs'), 'utf8'), owned);
});
