import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);
test('README binds the copied component to the actual checkout origin and immutable commit', async t => {
  const readme = await readFile(join(import.meta.dirname, '../README.md'), 'utf8');
  const recipe = readme.match(/<!-- adoption-origin -->\s*```sh\n([\s\S]*?)\n```/);
  assert.ok(recipe, 'real origin and revision come from the selected checkout');
  const component = JSON.parse(readme.match(/Declare the component[\s\S]*?```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(component.id, 'runeditrun/review-harness');
  assert.equal(component.source.origin.repository, 'BASE_REPOSITORY');
  assert.equal(component.source.origin.revision, 'PIN');
  const directory = await temporary(t), repository = 'https://github.com/octocat/Hello-World.git';
  const git = async (...args) => execute('git', ['-C', directory, ...args]);
  await git('init', '-q');
  await git('-c', 'user.name=Origin proof', '-c', 'user.email=origin@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Origin proof');
  await git('remote', 'add', 'origin', repository);
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
  const script = recipe[1].replaceAll('BASE_CHECKOUT', '.') + `
export BASE_REPOSITORY PIN
node --input-type=module -e 'console.log(JSON.stringify({repository:process.env.BASE_REPOSITORY,revision:process.env.PIN}))'`;
  const result = JSON.parse((await execute('bash', ['-c', script], { cwd: directory })).stdout);
  assert.deepEqual(result, { repository, revision });
  assert.match(result.revision, /^[0-9a-f]{40}$/);
  component.source.origin = { ...component.source.origin, ...result };
  assert.equal(component.source.origin.repository, repository);
  assert.equal(component.source.origin.revision, revision);
});
