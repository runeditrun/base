import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {refreshCopies} from './base-copies.mjs';
import {hash, json} from './files.mjs';
import {fixture, write, commit, git, snapshot, refused, collisionClasses} from './copy-planner-fixture.mjs';

test('refresh rejects generated full-fold destination classes and removal aliases in either order', t => {
  const {base, seed, revision} = fixture(t, {'left/old.json': '{}\n', 'right/old.json': '{}\n'}, [['initial-left', 'left'], ['initial-right', 'right']]);
  write(base, 'left/new.json', '1\n'); write(base, 'right/new.json', '2\n');
  const target = commit(base), classes = collisionClasses();
  // Two retired singleton removals must use that same destination identity.
  for (const pair of [['shared/ẞ.json', 'shared/SS.json'], ['shared/SS.json', 'shared/ẞ.json']]) {
    const copies = pair.map((name, i) => ({path: name, originPath: (i ? 'right' : 'left') + '/old.json', revision, files: {[name]: hash('{}\n')}}));
    write(seed, 'base-copies.json', json({schemaVersion: 1, copies}));
    const before = snapshot(seed);
    assert.throws(() => refreshCopies(seed, {positional: [target], record: 'base-copies.json', base}), error => pair.every(name => error.message.includes(name)));
    assert.deepEqual(snapshot(seed), before);
  }
  for (const reverse of [false, true]) {
    const f = fixture(t, {'left/left.mjs': 'export {};\n', 'right/Helper.mjs': 'export {};\n', 'right/keep.mjs': 'export {};\n'}, [['SHARED', 'left'], ['shared', 'right']]);
    const record = JSON.parse(fs.readFileSync(path.join(f.seed, 'base-copies.json')));
    record.copies.sort((a, b) => (a.path === 'SHARED' ? -1 : 1) * (reverse ? -1 : 1));
    write(f.seed, 'base-copies.json', json(record)); git(f.seed, 'add', 'base-copies.json'); git(f.seed, 'commit', '--allow-empty', '-qm', 'record order');
    write(f.base, 'left/helper.mjs', 'export const added = true;\n'); fs.unlinkSync(path.join(f.base, 'right/Helper.mjs'));
    refused(f.seed, () => f.refresh(commit(f.base)), ['SHARED/helper.mjs', 'shared/Helper.mjs']);
  }
  const creation = fixture(t, {'left/tools/a.mjs': 'export {};\n', 'right/tools/b.mjs': 'export {};\n'}, [['scripts/a.mjs', 'left/tools/a.mjs'], ['scripts/b.mjs', 'right/tools/b.mjs']]);
  write(creation.base, 'left/tools/a.mjs', "import '../Parent/one.mjs';\n");
  write(creation.base, 'right/tools/b.mjs', "import '../parent/two.mjs';\n");
  write(creation.base, 'left/Parent/one.mjs', 'export {};\n'); write(creation.base, 'right/parent/two.mjs', 'export {};\n');
  refused(creation.seed, () => creation.refresh(commit(creation.base)), ['left/Parent/one.mjs', 'right/parent/two.mjs']);
  for (const {pair: [left, right]} of [...classes, {pair: ['Straße', 'Straẞe']}, {pair: ['ẞ', 'SS']}]) {
    // Missing recorded directory members are deliberate removals. New files
    // added at the target still require the complete destination preflight.
    const copies = [left, right].map((part, i) => ({path: 'shared/' + part, originPath: i ? 'right' : 'left', revision, files: {['shared/' + part + '/old.json']: hash('{}\n')}}));
    write(seed, 'base-copies.json', json({schemaVersion: 1, copies}));
    const before = snapshot(seed);
    assert.throws(() => refreshCopies(seed, {positional: [target], record: 'base-copies.json', base}), error =>
      error.message.includes(left + '/new.json') && error.message.includes(right + '/new.json'), `${left} / ${right}`);
    assert.deepEqual(snapshot(seed), before);
  }
  t.diagnostic(`${classes.reduce((sum, item) => sum + item.points.length, 0)} scalar values; ${classes.length} generated collision classes, all atomically refused`);
});

test('refresh preflights removals, existing files and creation ancestors before any mutation', t => {
  for (const kind of ['directory', 'symlink', 'fifo', 'helper', 'parent', 'ancestor', 'record', 'lock']) {
    const {base, seed, refresh} = fixture(t, {'tools/a.mjs': 'export {};\n', 'tools/b.mjs': 'export {};\n', 'tools/keep.mjs': 'export {};\n'});
    let blocked;
    if (['directory', 'symlink', 'fifo'].includes(kind)) {
      fs.unlinkSync(path.join(base, 'tools/a.mjs')); fs.unlinkSync(path.join(base, 'tools/b.mjs'));
      blocked = 'scripts/b.mjs'; fs.unlinkSync(path.join(seed, blocked));
      if (kind === 'directory') fs.mkdirSync(path.join(seed, blocked));
      if (kind === 'symlink') fs.symlinkSync('keep.mjs', path.join(seed, blocked));
      if (kind === 'fifo') execFileSync('mkfifo', [path.join(seed, blocked)]);
    } else {
      const helper = kind === 'ancestor' ? 'shared/new/directory/helper.mjs' : 'shared/helper.mjs';
      write(base, 'tools/a.mjs', `import '../${helper}';\n`); write(base, helper, 'export {};\n');
      if (kind === 'helper') write(seed, helper, 'export {};\n');
      if (['parent', 'ancestor'].includes(kind)) write(seed, 'shared/owner.json', '{}\n');
      if (kind === 'lock') write(seed, 'sources.lock.json', '{}\n');
      blocked = {helper, parent: 'shared', ancestor: 'shared', record: 'base-copies.json', lock: 'sources.lock.json'}[kind];
      fs.chmodSync(path.join(seed, blocked), ['parent', 'ancestor'].includes(kind) ? 0o555 : 0o444);
    }
    const target = commit(base);
    try { refused(seed, () => refresh(target), [blocked]); }
    finally { if (!['directory', 'symlink', 'fifo'].includes(kind)) fs.chmodSync(path.join(seed, blocked), ['parent', 'ancestor'].includes(kind) ? 0o755 : 0o644); }
  }
});

test('refresh compares every requesting origin through the whole transitive helper graph', t => {
  for (const [count, changed, mode] of [[2, false, false], [2, true, false], [3, true, false], [3, true, true]]) {
    const initial = Object.fromEntries(Array.from({length: count}, (_, i) => [`p${i}/tools/main.mjs`, 'export {};\n']));
    const mappings = Array.from({length: count}, (_, i) => [`scripts/main${i}.mjs`, `p${i}/tools/main.mjs`]);
    const {base, seed, refresh, cli} = fixture(t, initial, mappings);
    for (let i = 0; i < count; i++) {
      const value = changed && i === count - 1 && !mode ? 'B' : 'A';
      write(base, `p${i}/tools/main.mjs`, `import {value} from '../shared/helper.mjs'; if (value !== '${value}') throw Error('wrong closure');\n`);
      write(base, `p${i}/shared/helper.mjs`, "export {value} from './child.mjs';\n");
      write(base, `p${i}/shared/child.mjs`, "export {value} from './leaf.mjs';\n");
      write(base, `p${i}/shared/leaf.mjs`, `export const value = '${value}';\n`);
      if (changed && mode && i === count - 1) fs.chmodSync(path.join(base, `p${i}/shared/leaf.mjs`), 0o755);
    }
    const target = commit(base);
    if (changed) refused(seed, () => refresh(target), ['p0/shared/leaf.mjs', `p${count - 1}/shared/leaf.mjs`]);
    else {
      const result = refresh(target); assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(cli('verify-base').status, 0);
      for (let i = 0; i < count; i++) {
        const result = spawnSync(process.execPath, [`scripts/main${i}.mjs`], {cwd: seed, encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr);
      }
    }
  }
});
