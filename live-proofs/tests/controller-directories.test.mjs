import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyControllerFiles, reviewDescriptor } from '../standalone/review.mjs';
import { reviewedExecutor } from '../standalone/executor.mjs';
import { adapter } from '../standalone/adapters/happytohelp-v021.mjs';
import { Containers } from '../t016/isolation.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';
import { standaloneFixture } from './standalone-fixture.mjs';

function scratch(t) {
  assert(process.env.T016_TEST_TMP);
  const root = mkdtempSync(join(process.env.T016_TEST_TMP, 'directories-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test('public v0.2.1 collector executes with all 53 exact file pins and reviewed empty module root', async t => {
  const root = scratch(t), source = join(root, 'public'), reviewed = join(root, 'reviewed');
  assert(process.env.T016_PUBLIC_REPOSITORY, 'Supply a local Git repository containing the exact public tag; no fetch is performed');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: process.env.T016_PUBLIC_REPOSITORY, env: { PATH: process.env.PATH, HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = '59c6e2e1beb321e9f1cb5493efd05e20fc068638';
  assert.equal(adapter.sourceSha, sha); assert.equal(Object.keys(adapter.controllerFiles).length, 53);
  assert.deepEqual(adapter.controllerDirectories, ['src/modules']);
  assert.match(git(['ls-tree', sha, 'src/modules']).toString(), /^040000 tree [a-f0-9]{40}\tsrc\/modules\n$/);
  const descriptor = JSON.parse(git(['show', `${sha}:OPERATIONS.json`]));
  reviewDescriptor(descriptor, adapter, { from: '--local', to: '--remote' });
  for (const [path, hash] of Object.entries(adapter.controllerFiles)) {
    const bytes = git(['show', `${sha}:${path}`]); assert.equal(digest(bytes), hash, path);
    mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), bytes);
  }
  const publicPaths = git(['ls-tree', '-r', '--name-only', sha]).toString().trim().split('\n');
  const migrations = publicPaths.filter(path => /^(?:migrations|src\/modules\/[^/]+\/migrations)\/[^/]+\.sql$/.test(path));
  assert.deepEqual(migrations.sort(), Object.keys(adapter.controllerFiles).filter(path => path.endsWith('.sql')).sort());
  // Materialize an actual, unreviewed public executable as the exclusion control.
  const modulePath = publicPaths.find(path => /^src\/modules\/.*\.js$/.test(path)); assert(modulePath);
  mkdirSync(join(source, modulePath, '..'), { recursive: true }); writeFileSync(join(source, modulePath), git(['show', `${sha}:${modulePath}`]));
  const fileOnly = join(root, 'file-only');
  copyControllerFiles(source, fileOnly, adapter.controllerFiles);
  const oldCollector = await import(pathToFileURL(join(fileOnly, 'scripts/migrations.mjs')));
  await assert.rejects(oldCollector.collectMigrations(), { code: 'ENOENT' });
  copyControllerFiles(source, reviewed, adapter.controllerFiles, adapter.controllerDirectories);
  assert.deepEqual(readdirSync(join(reviewed, 'src/modules')), []);
  assert(!existsSync(join(reviewed, modulePath))); assert(!existsSync(join(reviewed, 'node_modules')));
  const collector = await import(pathToFileURL(join(reviewed, 'scripts/migrations.mjs')));
  const result = await collector.collectMigrations();
  assert.equal(result.files.length, 37);
  assert.deepEqual(result.files, migrations.map(path => path.split('/').at(-1)).sort());
  for (const [path, hash] of Object.entries(adapter.controllerFiles)) assert.equal(digest(readFileSync(join(reviewed, path))), hash, path);
  for (const path of migrations) assert.equal(digest(readFileSync(join(result.directory, path.split('/').at(-1)))), adapter.controllerFiles[path]);
});
test('directory review rejects traversal, duplicates, file collisions and build-output overlap', t => {
  const f = standaloneFixture(scratch(t));
  for (const directories of ['product/modules', ['../escape'], ['.git'], ['product/modules', 'product/modules'],
    ['product/setup.mjs'], ['product/setup.mjs/child'], ['product/dist'], ['product/dist/subdirectory']]) {
    assert.throws(() => reviewDescriptor(f.descriptor, { ...f.adapter, controllerDirectories: directories }));
  }
  assert.doesNotThrow(() => reviewDescriptor(f.descriptor, { ...f.adapter, controllerDirectories: ['product/modules'] }));
});
test('directory structure admits neither a source file nor a symlink as a directory', t => {
  const root = scratch(t), f = standaloneFixture(root);
  symlinkSync(join(f.directory, 'product'), join(f.directory, 'linked'));
  for (const path of ['product/setup.mjs', 'linked']) {
    assert.throws(() => copyControllerFiles(f.directory, join(root, path === 'linked' ? 'bad-link' : 'bad-file'),
      f.adapter.controllerFiles, [path]), /controller-directory-mismatch/);
  }
});
test('executor transfers reviewed directory declarations without copying their source children', async t => {
  const root = scratch(t), f = standaloneFixture(root), work = join(root, 'work'); mkdirSync(work);
  mkdirSync(join(f.directory, 'product/modules')); writeFileSync(join(f.directory, 'product/modules/unreviewed.txt'), 'excluded');
  const git = args => execFileSync('git', args, { cwd: f.directory, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['add', 'product/modules']); git(['commit', '-m', 'Directory test source']);
  f.adapter.sourceSha = git(['rev-parse', 'HEAD']); f.adapter.controllerDirectories = ['product/modules'];
  let inspected = false;
  t.mock.method(Containers.prototype, 'create', async (_image, mounts) => {
    const reviewed = mounts.find(mount => mount.target === '/source').source;
    assert.deepEqual(readdirSync(join(reviewed, 'product/modules')), []);
    assert(!existsSync(join(reviewed, 'product/build.mjs'))); inspected = true;
    throw new Error('stop-before-container-execution');
  });
  await assert.rejects(reviewedExecutor({ ...f, root: work, images: {}, inputs: { PROVIDER_TOKEN: 'synthetic-test-value' } }), /stop-before-container-execution/);
  assert(inspected); assert(!existsSync(join(work, 'broker')));
});
