import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {caseFoldMappings} from '../case-folding.mjs';

// Build the reference directly from the published table, independently of the
// destination key and its production folding function.
const reference = new Map(caseFoldMappings);
const fold = value => {
  let result = '';
  for (const character of value) result += reference.get(character) ?? character;
  return result;
};
const canonicalFold = value => fold(value.normalize('NFC')).normalize('NFC');

const env = {...process.env, GIT_OPTIONAL_LOCKS: '0'};
export const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {env, encoding: 'utf8', stdio: 'pipe'}).trim();
export const write = (root, name, bytes) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), bytes); };
export const commit = root => { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); };
export function fixture(t, initial = {'tools/main.mjs': 'export {};\n'}, mappings = [['scripts', 'tools']]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-planner-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const base = path.join(temp, 'base'), seed = path.join(temp, 'seed');
  for (const root of [base, seed]) {
    fs.mkdirSync(root); git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'core.precomposeUnicode', 'false');
  }
  for (const [name, bytes] of Object.entries(initial)) write(base, name, bytes);
  const revision = commit(base);
  const cli = (...args) => spawnSync(process.execPath, [path.join(import.meta.dirname, '../cli.mjs'), ...args, '--base', base], {cwd: seed, env, encoding: 'utf8'});
  for (const [destination, source] of mappings) {
    for (const [name, bytes] of Object.entries(initial)) if (name === source || name.startsWith(source + '/')) {
      const target = destination + name.slice(source.length); write(seed, target, bytes);
      const object = git(seed, 'hash-object', '-w', path.join(seed, target));
      git(seed, 'update-index', '--add', '--cacheinfo', '100644', object, target);
    }
    const recorded = cli('record-base', destination, source, revision);
    assert.equal(recorded.status, 0, recorded.stderr);
  }
  git(seed, 'add', 'base-copies.json'); git(seed, 'commit', '-qm', 'fixture');
  const refresh = revision => spawnSync(process.execPath, [path.join(import.meta.dirname, '../../bin/rer.mjs'), 'refresh-base', '--ref', revision, '--base', base, '--json'], {cwd: seed, env, encoding: 'utf8'});
  return {base, seed, revision, cli, refresh};
}
export function snapshot(root) {
  const values = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(path.join(root, directory))) {
      const name = directory ? directory + '/' + entry : entry;
      if (name === '.git') continue;
      const target = path.join(root, name), stat = fs.lstatSync(target);
      values[name] = {mode: stat.mode, bytes: stat.isFile() ? fs.readFileSync(target).toString('hex') : stat.isSymbolicLink() ? fs.readlinkSync(target) : null};
      if (stat.isDirectory()) visit(name);
    }
  };
  visit('');
  for (const [key, args] of [['status', ['status', '--porcelain=v1', '-uall']], ['diff', ['diff', '--binary', 'HEAD']], ['staged', ['diff', '--cached', '--binary']]]) {
    const result = spawnSync('git', ['-C', root, ...args], {env, encoding: 'utf8'});
    values[key] = {status: result.status, stdout: result.stdout, stderr: result.stderr};
  }
  values.index = fs.readFileSync(path.join(root, '.git/index')).toString('hex');
  return values;
}
export function refused(seed, action, names) {
  const before = snapshot(seed), result = action();
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  for (const name of names) assert.ok(output.includes(name), output);
  assert.deepEqual(snapshot(seed), before);
}

// Enumerate scalar values with the running Node's own case conversions. Keep
// every member, grouped by its portable equivalence class, without pinning the
// number or contents of the Unicode table.
export function collisionClasses() {
  const classes = new Map();
  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const character = String.fromCodePoint(point), folded = reference.get(character) ?? character;
    const lowerUpper = character.toUpperCase().toLowerCase(), upperLower = character.toLowerCase().toUpperCase();
    if (folded === lowerUpper && folded === upperLower) continue;
    const key = canonicalFold(character);
    const partner = [folded, lowerUpper, upperLower, character.toUpperCase(), character.toLowerCase()]
      .find(value => value !== character && canonicalFold(value) === key);
    // A singleton fold class (dotless i, for example) has no distinct scalar
    // partner. Preserve it verbatim and vary a neighboring ASCII case pair.
    const priority = folded === lowerUpper ? 0 : 1;
    const previous = classes.get(key);
    // Prefer a member that defeats lower(upper(x)), rather than letting an
    // ordinary member hide a broken round-trip key in this same fold class.
    if (!previous || priority > previous.priority) classes.set(key, {pair: partner ? [character, partner] : [character + 'A', character + 'a'], singleton: !partner, priority, points: previous?.points ?? []});
    classes.get(key).points.push(point);
  }
  return [...classes.values()];
}
