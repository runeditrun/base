// rer dev <repo> through the installed command's door: the clone it makes
// can check out an older release tag with no further fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage } from '../../scripts/rer-package.mjs';
import { run } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');

test('rer dev <repo> clones every release tag, so git checkout <tag> works in the clone', { timeout: 60000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-clone-')), source = join(directory, 'source'), home = join(directory, 'home');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await Promise.all([mkdir(source), mkdir(home)]);
 // The packed rer, as a person installs it.
 const unpacked = join(directory, 'rer');
 await mkdir(unpacked);
 assert.equal((await run('tar', ['-xzf', await buildPackage(base, join(directory, 'built')), '-C', unpacked])).code, 0);
 const rer = join(unpacked, 'package/global/rer.mjs');
 const env = { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
 const git = async (...args) => { const result = await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: source, env }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
 await git('init', '--quiet');
 await writeFile(join(source, 'release.txt'), 'v1.0.0\n');
 await git('add', '.'); await git('commit', '--quiet', '-m', 'First release'); await git('tag', 'v1.0.0');
 await writeFile(join(source, 'release.txt'), 'main\n');
 await git('commit', '--quiet', '-am', 'Later work');
 const remote = join(directory, 'app.git');
 await git('clone', '--quiet', '--bare', source, remote);

 // The source is not a runnable checkout, so the launch stops after the clone.
 const clone = join(directory, 'app');
 await run(process.execPath, [rer, 'dev', pathToFileURL(remote).href, '--dir', clone], { cwd: directory, env });
 const checkout = await run('git', ['-C', clone, 'checkout', '--quiet', 'v1.0.0'], { env });
 assert.equal(checkout.code, 0, checkout.stderr);
 assert.equal((await run('git', ['-C', clone, 'show', 'HEAD:release.txt'], { env })).stdout, 'v1.0.0\n');
});
