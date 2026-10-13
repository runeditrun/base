import { mkdir, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { catalog } from './options.mjs';
import { git } from './git.mjs';

const receiptPath = directory => join(directory, '.git', 'rer-setup.json');
export async function assertInstaller(directory, seed) {
  const path = join(directory, 'scripts', 'install.mjs');
  try {
    const actual = await realpath(path), root = await realpath(directory);
    const rel = relative(root, actual);
    if (rel.startsWith('..') || isAbsolute(rel) || !(await lstat(actual)).isFile()) throw Error();
  } catch { throw Error('Selected source has no supported scripts/install.mjs inside its checkout. Choose a revision that includes standalone onboarding.'); }
  const identities = [];
  for (const name of ['SEED.json', 'seed.json']) {
    try { identities.push(JSON.parse(await readFile(join(directory, name), 'utf8')).id); }
    catch (error) {
      if (error.code !== 'ENOENT') throw Error('Selected source has invalid seed product identity metadata.');
    }
  }
  if (!identities.length) throw Error('Selected source has no valid SEED.json or seed.json product identity.');
  if (identities.some(id => id !== seed)) throw Error('Selected source product does not match the requested seed.');
}

async function resume(options) {
  const directory = options.directory;
  let receipt;
  try {
    if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, '.git'))).isDirectory()) throw Error();
    receipt = JSON.parse(await readFile(receiptPath(directory), 'utf8'));
  } catch { throw Error('--resume requires an existing launcher-owned checkout with its .git/rer-setup.json receipt.'); }
  if (receipt.version !== 1 || receipt.seed !== options.seed || !/^[a-f0-9]{40,64}$/.test(receipt.commit) ||
      typeof receipt.repository !== 'string' || (options.repository && options.repository !== receipt.repository) ||
      (options.ref && options.ref !== receipt.requestedRef)) throw Error('Resume source does not match the saved launcher receipt.');
  if (await git(directory, ['rev-parse', '--show-toplevel'], options.signal) !== await realpath(directory) ||
      await git(directory, ['rev-parse', '--verify', 'refs/rer/setup-base^{commit}'], options.signal) !== receipt.commit) throw Error('Saved checkout base does not match the launcher receipt.');
  await assertInstaller(directory, options.seed);
  options.signal?.throwIfAborted();
  return receipt;
}

export async function acquire(options) {
  options.signal?.throwIfAborted();
  if (options.resume) return resume(options);
  const directory = options.directory, repository = options.repository || catalog[options.seed];
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('Destination already exists. Choose a new --directory, or use --resume for a launcher-owned checkout.');
    throw Error('Cannot create destination. Choose an existing parent directory with write access.');
  }
  const reservation = await lstat(directory);
  const runGit = args => git(directory, args, options.signal);
  try {
    await runGit(['clone', '--no-checkout', '--no-local', '--', repository, '.']);
    // Fetch once more only for an explicit ref; the default is the clone's actual remote HEAD.
    if (options.ref) await runGit(['fetch', '--', 'origin', options.ref]);
    const commit = await runGit(['rev-parse', '--verify', options.ref ? 'FETCH_HEAD^{commit}' : 'HEAD^{commit}']);
    await runGit(['checkout', '-B', 'rer-owner', commit]);
    await assertInstaller(directory, options.seed);
    await runGit(['update-ref', 'refs/rer/setup-base', commit]);
    const receipt = { version: 1, seed: options.seed, repository, requestedRef: options.ref || 'HEAD', commit, createdAt: new Date().toISOString() };
    await writeFile(receiptPath(directory), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    options.signal?.throwIfAborted();
    return receipt;
  } catch (error) {
    // Only this invocation's exclusively created acquisition is removable.
    const current = await lstat(directory).catch(() => null);
    if (current?.isDirectory() && current.dev === reservation.dev && current.ino === reservation.ino) {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
