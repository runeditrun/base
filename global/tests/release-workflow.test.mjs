import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = await readFile(new URL('../../.github/workflows/rer-release.yml', import.meta.url), 'utf8');
function step(name) {
 const start = workflow.indexOf(`      - name: ${name}\n`);
 assert.notEqual(start, -1, `Workflow step ${name} exists`);
 const block = workflow.slice(start).match(/^        run: \|\n((?:          [^\n]*\n|\n)*)/m);
 assert.ok(block, `Workflow step ${name} has a Bash command`);
 return block[1].replace(/^          /gm, '');
}

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-release-workflow-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const bin = join(root, 'bin'), calls = join(root, 'calls.jsonl');
 await Promise.all([mkdir(bin), mkdir(join(root, 'global')), mkdir(join(root, 'dist'))]);
 // Only the external GitHub/npm commands are replaced; Bash and Git are real.
 for (const tool of ['gh', 'npm']) await writeFile(join(bin, tool), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify({ tool: ${JSON.stringify(tool)}, args }) + '\\n');
if (${JSON.stringify(tool)} === 'gh' && args[0] === 'api') console.log(process.env.GREEN);
else if (args.includes('view')) process.exit(1);
`, { mode: 0o755 });
 const env = {
  PATH: `${bin}:${process.env.PATH}`, HOME: root, CALLS: calls, GREEN: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_EMAIL: 'test@example.test',
  GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REPOSITORY: 'example/base',
  GITHUB_ENV: join(root, 'env'), GITHUB_OUTPUT: join(root, 'output'),
  RUNNER_TEMP: root, DIST: join(root, 'dist'),
 };
 const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
 };
 git('init', '--quiet', '--initial-branch=main');
 git('commit', '--quiet', '--allow-empty', '-m', 'Common source');
 const common = git('rev-parse', 'HEAD');
 git('checkout', '--quiet', '-b', 'next/business');
 git('commit', '--quiet', '--allow-empty', '-m', 'Business work');
 const business = git('rev-parse', 'HEAD');
 git('update-ref', 'refs/remotes/origin/next/business', business);
 git('checkout', '--quiet', 'main');
 git('commit', '--quiet', '--allow-empty', '-m', 'Main work');
 const main = git('rev-parse', 'HEAD');
 git('update-ref', 'refs/remotes/origin/main', main);
 const run = (name, extra = {}) => spawnSync('bash', ['-euo', 'pipefail', '-c', step(name)], {
  cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
 });
 return {
  root, env, main, business, common, run,
  async calls() { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); },
  async mode({ version, sha = business, tag = `rer-v${version}`, ...extra }) {
   await writeFile(join(root, 'global/package.json'), JSON.stringify({ version }));
   await writeFile(env.GITHUB_OUTPUT, '');
   await writeFile(calls, '');
   const result = run('Release or dry run', {
    GITHUB_SHA: sha, GITHUB_REF_NAME: tag, GITHUB_REF: `refs/tags/${tag}`, ...extra,
   });
   const outputs = Object.fromEntries((await readFile(env.GITHUB_OUTPUT, 'utf8')).trim().split('\n').filter(Boolean).map(line => line.split('=')));
   return { result, outputs };
  },
 };
}

test('release workflow selects the branch and npm channel and requires exact-commit Verify', async t => {
 const f = await fixture(t);
 for (const [version, sha, channel, prerelease] of [
  ['1.2.3-next.4', f.business, 'next', 'true'],
  ['1.2.3', f.main, 'latest', 'false'],
 ]) {
  const { result, outputs } = await f.mode({ version, sha });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(outputs, { publish: 'true', 'dist-tag': channel, prerelease });
  const [verify] = await f.calls();
  assert.equal(verify.tool, 'gh');
  const query = new URL(verify.args[1], 'https://api.github.test/');
  assert.ok(query.pathname.endsWith('/actions/workflows/verify.yml/runs'));
  assert.equal(query.searchParams.get('head_sha'), sha);
  assert.equal(query.searchParams.get('status'), 'success');
 }
 for (const candidate of [
  { version: '1.2.3-next.4', sha: f.main },
  { version: '1.2.3', sha: f.business },
  { version: '1.2.3-rc.1', sha: f.common },
  { version: '1.2.3-dev.g12345678', sha: f.common },
  { version: '1.2.3-next.01' },
  { version: '1.2.3-next.1.extra' },
  { version: '1.2.3-next.4', tag: 'rer-v1.2.3-next.5' },
  { version: '1.2.3', tag: 'rer-v1.2.4', sha: f.main },
  { version: '1.2.3-next.4', GREEN: '0' },
  { version: '1.2.3', sha: f.main, GREEN: '0' },
 ]) {
  const { result, outputs } = await f.mode(candidate);
  assert.notEqual(result.status, 0, JSON.stringify(candidate));
  assert.notEqual(outputs.publish, 'true');
 }
 const { result, outputs } = await f.mode({ version: '1.2.3', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch' });
 assert.equal(result.status, 0, result.stdout + result.stderr);
 assert.equal(outputs.publish, 'false');
 assert.deepEqual(await f.calls(), []);
});

test('release workflow checks the packed version before any publication', async t => {
 const f = await fixture(t);
 for (const [version, prerelease, tag, publish, accepted] of [
  ['1.2.3', 'false', 'rer-v1.2.3', 'true', true],
  ['1.2.3-next.4', 'true', 'rer-v1.2.3-next.4', 'true', true],
  ['1.2.3-next.4', 'false', 'rer-v1.2.3-next.4', 'true', false],
  ['1.2.3-rc.1', 'true', 'rer-v1.2.3-rc.1', 'true', false],
  ['1.2.3-dev.g12345678', 'true', 'rer-v1.2.3', 'true', false],
  ['1.2.4', 'false', 'rer-v1.2.3', 'true', false],
  ['1.2.3-dev.g12345678', 'false', '', 'false', true],
 ]) {
  const result = f.run('The version carries no development stamp', { VERSION: version, PRERELEASE: prerelease, GITHUB_REF_NAME: tag, PUBLISH: publish });
  assert.equal(result.status === 0, accepted, result.stdout + result.stderr);
 }
});

test('release workflow publishes the selected npm dist-tag and records prereleases', async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, 'dist/scan.json'), JSON.stringify({ status: 'PASS', findings: [] }));
 await writeFile(join(f.root, 'dist/SHA256SUMS'), 'test checksum\n');
 for (const [version, channel, prerelease] of [['1.2.3', 'latest', 'false'], ['1.2.3-next.4', 'next', 'true']]) {
  const env = { VERSION: version, DIST_TAG: channel, PRERELEASE: prerelease, GITHUB_SHA: f.business,
   GITHUB_REF_NAME: `rer-v${version}`, TARBALL: join(f.root, 'dist/package.tgz'), NODE_AUTH_TOKEN: '', INTEGRITY: 'test-integrity' };
  for (const name of ['Publish to npm', 'Record the release']) {
   const result = f.run(name, env);
   assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const calls = await f.calls();
  const publish = calls.findLast(call => call.tool === 'npm' && call.args[0] === 'publish');
  assert.equal(publish.args[publish.args.indexOf('--tag') + 1], channel);
  assert.ok(publish.args.includes('--provenance=false'));
  const release = calls.findLast(call => call.tool === 'gh' && call.args[1] === 'create');
  assert.equal(release.args.includes('--prerelease'), prerelease === 'true');
  if (prerelease === 'true') assert.ok(release.args.includes('--latest=false'));
  assert.ok(release.args.includes('--verify-tag'));
 }
});
