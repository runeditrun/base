import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publicExport } from './export.mjs';
import { archiveMembers } from './archive-members.mjs';
import { assertArchiveTracked } from './archive-guard.mjs';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'appledouble-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const sourceOf = files => ({ commit: 'a'.repeat(40),
  entries: new Map(Object.keys(files).map(path => [path, { mode: '100644', type: 'blob' }])),
  bytes: path => Buffer.from(files[path]) });
const names = archive => archiveMembers(archive).map(member => member.path.replace(/^\.\/?/, '').replace(/\/$/, '')).filter(Boolean).sort();

test('the public archive holds the tracked files and directories and no AppleDouble entry', t => {
  const root = scratch(t), output = join(root, 'out');
  mkdirSync(output);
  mkdirSync(join(root, 'tmp'));
  publicExport(sourceOf({ 'a.txt': 'a', 'dir/b.txt': 'b', 'dir/sub/c.txt': 'c' }), join(root, 'tmp'), output);
  assert.deepEqual(names(join(output, 'public-source.tar')), ['a.txt', 'dir', 'dir/b.txt', 'dir/sub', 'dir/sub/c.txt']);
});

test('a tracked file whose name starts with ._ is still archived', t => {
  const root = scratch(t), output = join(root, 'out');
  mkdirSync(output);
  mkdirSync(join(root, 'tmp'));
  publicExport(sourceOf({ '._keep': 'k', 'dir/._also': 'x', 'a.txt': 'a' }), join(root, 'tmp'), output);
  assert.deepEqual(names(join(output, 'public-source.tar')), ['._keep', 'a.txt', 'dir', 'dir/._also']);
});

test('the guard refuses an untracked AppleDouble entry with a message', t => {
  const root = scratch(t), tree = join(root, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'a.txt'), 'a');
  writeFileSync(join(tree, '._a.txt'), 'appledouble');
  const archive = join(root, 'injected.tar');
  execFileSync('tar', ['-cf', archive, '-C', tree, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  assert.throws(() => assertArchiveTracked(archive, ['a.txt']), /AppleDouble entry that are not tracked paths \(first: \._a\.txt\)/);
  assertArchiveTracked(archive, ['a.txt', '._a.txt']);
});
