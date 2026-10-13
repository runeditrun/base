import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourcePath, containerCwd, snapshotSource, copyControllerFiles, reviewDescriptor } from '../standalone/review.mjs';
import { publicSource } from '../t016/profile.mjs';
import { unpackArtifact } from '../t016/artifact.mjs';
import { adapter } from '../standalone/adapters/happytohelp-v021.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';
import { standaloneFixture } from './standalone-fixture.mjs';

function scratch(t) {
  assert(process.env.T016_TEST_TMP);
  const root = resolve(mkdtempSync(join(process.env.T016_TEST_TMP, 'paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  const git = (cwd, args, input) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  return { root, env, git };
}
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const path = prefix ? prefix + '/' + name : name;
    return lstatSync(join(root, path)).isDirectory() ? files(root, path) : [path];
  }).sort();
}
for (const [ref, sha] of [[publicSource.previousRef, publicSource.previousSha], [publicSource.ref, publicSource.sha]]) {
  test(`snapshot preserves every pinned public ${ref} path, blob and executable mode`, async t => {
    const { root, env, git } = scratch(t), directory = join(root, 'objects.git'), destination = join(root, 'snapshot');
    assert(process.env.T016_PUBLIC_REPOSITORY, 'Supply local public Git objects; no fetch is performed');
    const repository = resolve(process.env.T016_PUBLIC_REPOSITORY);
    assert.equal(git(repository, ['rev-parse', `${ref}^{commit}`]).toString().trim(), sha);
    git(root, ['init', '--bare', directory]);
    writeFileSync(join(directory, 'objects/info/alternates'), resolve(repository,
      git(repository, ['rev-parse', '--git-path', 'objects']).toString().trim()) + '\n');
    git(directory, ['update-ref', '--no-deref', 'HEAD', sha]);
    const entries = git(directory, ['ls-tree', '-rz', '--full-tree', sha]).toString().split('\0').filter(Boolean).map(line => {
      const [, mode, hash, path] = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);
      return { mode, hash, path };
    });
    assert(entries.some(entry => entry.path.includes('$')), 'actual native dynamic route present');
    await snapshotSource({ directory, sourceSha: sha, destination, env });
    assert.deepEqual(files(destination), entries.map(entry => entry.path).sort());
    for (const entry of entries) {
      const path = join(destination, entry.path);
      assert.equal(blobHash(readFileSync(path)), entry.hash, entry.path);
      assert.equal(lstatSync(path).mode & 0o777, entry.mode === '100755' ? 0o755 : 0o644, entry.path);
    }
    if (sha === adapter.sourceSha) {
      assert.equal(Object.keys(adapter.controllerFiles).length, 53);
      const descriptor = JSON.parse(readFileSync(join(destination, 'OPERATIONS.json')));
      reviewDescriptor(descriptor, adapter, { from: '--local', to: '--remote' });
      const reviewed = join(root, 'reviewed');
      copyControllerFiles(destination, reviewed, adapter.controllerFiles, adapter.controllerDirectories);
      assert.deepEqual(files(reviewed), Object.keys(adapter.controllerFiles).sort());
      for (const [path, hash] of Object.entries(adapter.controllerFiles)) assert.equal(digest(readFileSync(join(reviewed, path))), hash, path);
      assert.deepEqual(readdirSync(join(reviewed, 'src/modules')), []);
    }
    t.diagnostic(`${ref} ${sha}: ${entries.length} exact Git blobs and modes preserved`);
  });
}

test('native filenames remain literal through immutable snapshot and controller copy', async t => {
  const { root, env, git } = scratch(t), directory = join(root, 'project'), destination = join(root, 'snapshot');
  mkdirSync(directory); git(directory, ['init']);
  const paths = ['routes/$tenant/[...slug].tsx', 'app/(group)/@modal/{-$optional}.tsx',
    'docs/café 日本語 #1!.md', 'notes/a:b&c;d="x"\'`e`.txt', '-leading/$([literal]).sh'];
  const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
  for (const path of paths) {
    assert.equal(sourcePath(path), path); assert.equal(containerCwd(path), '/seed/' + path);
    mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), bytes);
  }
  chmodSync(join(directory, paths.at(-1)), 0o755);
  git(directory, ['add', '.']); git(directory, ['commit', '-m', 'Native filename test']);
  const sourceSha = git(directory, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(directory, paths[0]), 'uncommitted alteration');
  await snapshotSource({ directory, sourceSha, destination, env });
  for (const path of paths) assert.deepEqual(readFileSync(join(destination, path)), bytes);
  assert.equal(lstatSync(join(destination, paths.at(-1))).mode & 0o777, 0o755);
  const reviewed = join(root, 'reviewed');
  copyControllerFiles(destination, reviewed, { [paths[0]]: digest(bytes) });
  assert.deepEqual(files(reviewed), [paths[0]]); assert.deepEqual(readFileSync(join(reviewed, paths[0])), bytes);
});

test('relative paths reject traversal, aliases, controls, drive roots and ambiguous separators', () => {
  const invalid = ['', '.', '..', '/absolute', '//host/share', 'C:/absolute', 'C:relative', 'a\\b', '\\server\\share',
    'a//b', 'a/', './a', 'a/./b', 'a/../b', '../outside', '.git/config', 'a/.git/config', 'a\0b',
    'a\nb', 'a\rb', 'a\tb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\ud800b'];
  for (const path of invalid) assert.throws(() => sourcePath(path), /unsafe-source-path/, JSON.stringify(path));
  assert.equal(sourcePath('.', true), '.'); assert.equal(containerCwd('.'), '/seed');
  for (const path of invalid.filter(path => path !== '.')) assert.throws(() => sourcePath(path, true), /unsafe-source-path/);
});

test('Git symlinks, submodules, control paths and invalid UTF-8 fail before materialization', async t => {
  const { root, env, git } = scratch(t), directory = join(root, 'objects.git'); git(root, ['init', '--bare', directory]);
  const blob = git(directory, ['hash-object', '-w', '--stdin'], Buffer.from('../outside')).toString().trim();
  const cases = [ ['120000', Buffer.from('linked')], ['160000', Buffer.from('module')],
    ['100644', Buffer.from('line\nbreak')], ['100644', Buffer.from('a\\b')], ['100644', Buffer.from([0xff])],
    ['100644', Buffer.from('../escape')], ['100644', Buffer.from('/absolute')], ['100644', Buffer.from('.git')] ];
  for (const [index, [mode, name]] of cases.entries()) {
    const tree = git(directory, ['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'],
      Buffer.concat([Buffer.from(mode + ' '), name, Buffer.from([0]), Buffer.from(blob, 'hex')])).toString().trim();
    const sourceSha = git(directory, ['commit-tree', tree, '-m', 'Unsafe source test']).toString().trim();
    git(directory, ['update-ref', '--no-deref', 'HEAD', sourceSha]);
    const destination = join(root, 'rejected-' + index);
    await assert.rejects(snapshotSource({ directory, sourceSha, destination, env }), /unsafe-source-path|source-nonregular-file/);
    assert(!existsSync(destination));
  }
});

test('reviewed file and directory reads refuse symlink ancestors or leaves', t => {
  const { root } = scratch(t), source = join(root, 'source'), outside = join(root, 'outside');
  mkdirSync(source); mkdirSync(outside); writeFileSync(join(outside, 'file'), 'reviewed bytes');
  symlinkSync(outside, join(source, 'linked')); symlinkSync(join(outside, 'file'), join(source, 'file-link'));
  for (const [index, path] of ['linked/file', 'file-link'].entries()) assert.throws(() =>
    copyControllerFiles(source, join(root, 'bad-file-' + index), { [path]: digest('reviewed bytes') }), /controller-file-mismatch/);
  mkdirSync(join(outside, 'child'));
  assert.throws(() => copyControllerFiles(source, join(root, 'bad-directory'), {}, ['linked/child']), /controller-directory-mismatch/);
});

test('expanded filename syntax grants no new descriptor or environment authority', t => {
  const f = standaloneFixture(scratch(t).root);
  const descriptor = structuredClone(f.descriptor); descriptor.commands.deploy.cwd = 'product/$tenant';
  assert.throws(() => reviewDescriptor(descriptor, f.adapter), /unreviewed-descriptor/);
  const reviewed = { ...f.adapter, descriptorSha256: digest(descriptor) };
  assert.equal(reviewDescriptor(descriptor, reviewed).commands[1].cwd, 'product/$tenant');
  assert.throws(() => reviewDescriptor(descriptor, { ...reviewed, deploymentEnvironment: [] }), /unreviewed-deployment-environment/);
  assert.throws(() => reviewDescriptor(descriptor, { ...reviewed, builds: [{ ...reviewed.builds[0], output: 'product/setup.mjs/[$]' }] }), /artifact-controller-overlap/);
});

function archive(name, type = '0') {
  const h = Buffer.alloc(512), bytes = Buffer.from('untrusted archive data');
  h.write(name); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.fill(32, 148, 156); h.write(type, 156);
  h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, bytes, Buffer.alloc(512 - bytes.length), Buffer.alloc(1024)]);
}
test('source path support does not relax the separate untrusted archive boundary', t => {
  const { root } = scratch(t);
  for (const [index, name] of ['../escape', '/absolute', 'a/../escape', 'a//b', 'a\\b', 'C:/drive', 'a\nb'].entries()) {
    assert.throws(() => unpackArtifact(archive(name), join(root, 'archive-' + index), 'dist'), /unsafe-artifact-entry/);
  }
  for (const type of ['1', '2', '3', '4', '6']) assert.throws(() => unpackArtifact(archive('file', type), root, 'dist'), /unsafe-artifact-entry/);
  assert(!existsSync(join(root, 'dist')));
});
