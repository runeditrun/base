import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, repositorySource } from '../lib/options.mjs';
import { acquire } from '../lib/acquire.mjs';
import { git } from '../lib/git.mjs';

async function fixture(t, { product = 'ferry', installer = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rer-launcher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), directory = join(root, 'owned');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'SEED.json'), JSON.stringify({ id: product }));
  if (installer) await writeFile(join(source, 'scripts', 'install.mjs'), '// Acquisition fixture; never executed.\n');
  await git(source, ['init', '-b', 'rer-owner']);
  await git(source, ['add', '.']);
  await git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture source']);
  return { source, directory, root, options: { seed: 'ferry', repository: source, directory } };
}

test('arguments preserve caller answer paths and reject unsafe inputs', () => {
  const parsed = parseArgs(['ferry', '--repository', '/tmp/source', '--answers', './answers.json', '--agent', '--port', '0'], '/tmp/caller');
  assert.equal(parsed.directory, '/tmp/caller/ferry');
  assert.deepEqual(parsed.installerArgs, ['--answers', '/tmp/caller/answers.json', '--agent', '--port', '0']);
  for (const value of ['https://token@host/repo', 'https://host/repo?token=secret', 'ssh://git:secret@host/repo', 'ext::bad', '-bad']) {
    assert.throws(() => repositorySource(value, '/tmp'));
  }
  for (const args of [['unknown'], ['ferry', '--ref', '--upload-pack=bad'], ['ferry', '--ref', 'main:target'], ['ferry', '--port', '65536'], ['ferry', '--resume', '--no-prefill']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('acquisition pins actual commit including a source default named rer-owner', async t => {
  const { source, directory, options } = await fixture(t);
  const expected = await git(source, ['rev-parse', 'HEAD']);
  const receipt = await acquire(options);
  assert.equal(receipt.commit, expected);
  assert.equal(await git(directory, ['rev-parse', 'HEAD']), expected);
  assert.equal(await git(directory, ['rev-parse', 'refs/rer/setup-base']), expected);
  assert.equal(await git(directory, ['remote', 'get-url', 'origin']), source);
  assert.equal((await stat(join(directory, '.git', 'rer-setup.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.git', 'rer-setup.json'), 'utf8')), receipt);
});

test('resume preserves owner changes and HEAD while upstream moves', async t => {
  const { source, directory, options } = await fixture(t);
  const receipt = await acquire(options);
  await writeFile(join(directory, 'owner.txt'), 'customisation');
  await git(directory, ['add', 'owner.txt']);
  await git(directory, ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-m', 'Owner change']);
  const ownedHead = await git(directory, ['rev-parse', 'HEAD']);
  await writeFile(join(source, 'upstream.txt'), 'later upstream');
  await git(source, ['add', '.']);
  await git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Later source']);
  assert.deepEqual(await acquire({ ...options, resume: true }), receipt);
  assert.equal(await git(directory, ['rev-parse', 'HEAD']), ownedHead);
  assert.equal(await readFile(join(directory, 'owner.txt'), 'utf8'), 'customisation');
  await writeFile(join(directory, 'SEED.json'), JSON.stringify({ id: 'beacon' }));
  await assert.rejects(acquire({ ...options, resume: true }), /product does not match/);
  assert.equal(await readFile(join(directory, 'owner.txt'), 'utf8'), 'customisation');
});

test('existing paths and symlinks never overwritten, missing installer cleans only own acquisition', async t => {
  const { source, directory, root, options } = await fixture(t, { installer: false });
  await assert.rejects(acquire(options), /no supported scripts\/install.mjs/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await mkdir(directory);
  await writeFile(join(directory, 'keep'), 'owner data');
  await assert.rejects(acquire(options), /already exists/);
  await assert.rejects(acquire({ ...options, resume: true }), /launcher-owned/);
  assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'owner data');
  const link = join(root, 'link');
  await symlink(source, link);
  await assert.rejects(acquire({ ...options, directory: link }), /already exists/);
  await assert.rejects(acquire({ ...options, directory: link, resume: true }), /launcher-owned/);
});

test('wrong product and unavailable ref fail before launch and leave no destination', async t => {
  const { directory, options } = await fixture(t, { product: 'beacon' });
  await assert.rejects(acquire(options), /product does not match/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await assert.rejects(acquire({ ...options, ref: 'missing-ref' }), /Git fetch failed/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('cancelling acquisition waits for Git and removes only the new checkout', async t => {
  const { source, directory, options } = await fixture(t);
  const controller = new AbortController();
  const acquisition = acquire({ ...options, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(acquisition, /cancelled|aborted/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.equal(await readFile(join(source, 'SEED.json'), 'utf8'), '{"id":"ferry"}');
});
