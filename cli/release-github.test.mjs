import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture } from '../modules/release/test-fixture.mjs';
import { exportCLI } from './export.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

const base = resolve(import.meta.dirname, '..');
const repository = 'octocat/Hello-World';
const marker = name => `node -e "require('node:fs').writeFileSync(process.env.${name}, 'ran')"`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));

async function source(t, { localPass = false, portable = false, buildFailure = false } = {}) {
  const f = fixture(t, `${marker('VERIFY_MARKER')} && node --test check.test.mjs${localPass ? '' : ' && node -e "process.exit(7)"'}`);
  const pkg = read(join(f.repo, 'package.json'));
  pkg.scripts.build = `node -e "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/bundle.js','export const released = true;')" && ${marker('BUILD_MARKER')}`;
  if (buildFailure) pkg.scripts.build += ' && node -e "process.exit(9)"';
  pkg.scripts['verify:release'] = `${marker('RELEASE_MARKER')}${localPass ? '' : ' && node -e "process.exit(8)"'}`;
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(f.repo, '.gitignore'), 'dist/\n');
  f.sha = f.commit();
  execFileSync('git', ['-C', f.repo, 'remote', 'add', 'origin', `git@github.com:${repository}.git`]);
  const commands = join(f.temporary, 'commands'); mkdirSync(commands);
  const responses = join(f.temporary, 'responses.json'), calls = join(f.temporary, 'calls.jsonl');
  writeFileSync(calls, '');
  const gh = join(commands, 'gh');
  // The only fake is GitHub's network boundary, shared with publication scan.
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2), path = args.at(-1);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
if (args.includes('--include')) { process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n{"private":false}'); }
else if (Object.hasOwn(responses, path)) { process.stdout.write(JSON.stringify(responses[path])); }
else { process.stderr.write('unexpected API request'); process.exitCode = 1; }
`);
  writeFileSync(join(commands, 'package.json'), '{"type":"commonjs"}'); chmodSync(gh, 0o755);
  const env = await isolatedQueue(t, { ...process.env, PATH: commands + ':' + process.env.PATH,
    BUILD_MARKER: join(f.temporary, 'built'), VERIFY_MARKER: join(f.temporary, 'verified'), RELEASE_MARKER: join(f.temporary, 'release-verified') });
  let cli = join(base, 'bin/rer.mjs');
  if (portable) {
    const target = join(f.temporary, 'portable'); await exportCLI(base, target);
    await cp(join(base, 'onboarding'), join(target, 'scripts/base-onboarding'), { recursive: true });
    cli = join(target, 'scripts/rer.mjs');
  }
  const run = { id: 12345, workflow_id: 42, head_sha: f.sha, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', repository: { full_name: repository }, head_repository: { full_name: repository } };
  let attempt = 0;
  function invoke(runs = [run], flags = [], extra = {}) {
    writeFileSync(responses, JSON.stringify({
      [`repos/${repository}`]: { full_name: repository, default_branch: 'main' },
      [`repos/${repository}/actions/workflows?per_page=100`]: [{ workflows: [{ id: 42, name: 'Verify' }] }],
      [`repos/${repository}/actions/workflows/42/runs?head_sha=${f.sha}&per_page=100`]: [{ workflow_runs: runs }], ...extra,
    }));
    const output = join(f.temporary, 'release-' + attempt++);
    const result = spawnSync(process.execPath, [cli, 'release', '--repo', f.repo, '--project', repository,
      '--repository', 'https://github.com/' + repository, '--ref', f.sha, '--output', output, '--dry-run', ...flags],
    { cwd: f.temporary, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.stderr, '', result.stderr);
    return { result, receipt: JSON.parse(result.stdout), output };
  }
  return { ...f, env, calls, run, invoke };
}

test('exported rer release consumes exact GitHub Verify, builds and packages without either local verify target', async t => {
  const f = await source(t, { portable: true });
  const { result, receipt, output } = f.invoke([f.run], ['--tag']);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(receipt.status, 'DRY_RUN');
  assert.equal(receipt.gates.verify.runId, f.run.id);
  assert.equal(receipt.gates.verify.commit, f.sha);
  assert.equal(receipt.gates.verify.runUrl, `https://github.com/${repository}/actions/runs/${f.run.id}`);
  assert.equal(receipt.gates.verify.install.status, 'PASS');
  assert.equal(receipt.gates.verify.build.status, 'PASS');
  assert.equal(existsSync(f.env.BUILD_MARKER), true);
  assert.equal(existsSync(f.env.VERIFY_MARKER), false);
  assert.equal(existsSync(f.env.RELEASE_MARKER), false);
  assert.equal(receipt.gates.publishCheck.status, 'PASS');
  assert.equal(existsSync(join(output, receipt.publicExport.path)), true);
  assert.equal(receipt.tag.created, false);
  assert.equal(execFileSync('git', ['-C', f.repo, 'tag', '--list'], { encoding: 'utf8' }), '');
  assert.equal(read(join(output, receipt.siteRelease.path)).provenance.gates.verify.runId, f.run.id);
});

test('rer release refuses absent, unsuccessful or untrusted GitHub evidence with actionable reasons', async t => {
  const f = await source(t);
  for (const [name, patch, reason] of [
    ['no run', null, /No runs found/],
    ['failed', { conclusion: 'failure' }, /conclusion failure/],
    ['cancelled', { conclusion: 'cancelled' }, /conclusion cancelled/],
    ['pending', { status: 'in_progress', conclusion: null }, /not completed/],
    ['wrong SHA', { head_sha: 'a'.repeat(40) }, /different source SHA/],
    ['pull request merge ref', { event: 'pull_request', head_branch: 'refs/pull/1/merge' }, /event must be/],
    ['wrong repository', { repository: { full_name: 'other/source' } }, /different source repository/],
    ['fork', { head_repository: { full_name: 'other/source' } }, /different source repository/],
    ['wrong workflow', { workflow_id: 43 }, /different workflow/],
    ['feature branch', { head_branch: 'feature' }, /neither default branch nor release tag/],
  ]) await t.test(name, () => {
    const { result, receipt } = f.invoke(patch ? [{ ...f.run, ...patch }] : []);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(receipt.gates.verify.status, 'FAIL');
    assert.match(receipt.gates.verify.details, reason);
    assert.ok(receipt.gates.verify.message.includes(f.sha));
    assert.match(receipt.gates.verify.message, /Push.*re-run.*--local-verify/);
    assert.equal(receipt.publicExport, null);
    assert.equal(existsSync(f.env.BUILD_MARKER), false);
    assert.equal(existsSync(f.env.VERIFY_MARKER), false);
  });
  for (const [extra, reason] of [
    [{ [`repos/${repository}/actions/workflows?per_page=100`]: [{ workflows: [] }] }, /No Verify workflow/],
    [{ [`repos/${repository}`]: {} }, /gh authentication/],
  ]) {
    const { result, receipt } = f.invoke([], [], extra);
    assert.equal(result.status, 1, result.stdout);
    assert.match(receipt.gates.verify.details, reason);
  }
});

test('rer release accepts a dispatched release tag only when the remote tag resolves to the source commit', async t => {
  const f = await source(t);
  const path = `repos/${repository}/git/ref/tags/v1.2.3`, annotation = 'b'.repeat(40);
  const accepted = f.invoke([{ ...f.run, event: 'workflow_dispatch', head_branch: 'v1.2.3' }], [], {
    [path]: { object: { type: 'tag', sha: annotation } },
    [`repos/${repository}/git/tags/${annotation}`]: { object: { type: 'commit', sha: f.sha } },
  });
  assert.equal(accepted.result.status, 0, accepted.result.stdout);
  const refused = f.invoke([{ ...f.run, head_branch: 'v1.2.3' }], [], { [path]: { object: { type: 'commit', sha: 'c'.repeat(40) } } });
  assert.equal(refused.result.status, 1, refused.result.stdout);
  assert.match(refused.receipt.gates.verify.details, /tag points at a different commit/);
});

test('rer release --local-verify keeps frozen install, full verify and release-only verify without an Actions lookup', async t => {
  const f = await source(t, { localPass: true });
  const { result, receipt } = f.invoke([], ['--local-verify']);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(receipt.gates.verify.passed, 1);
  assert.equal(receipt.gates.verify.release.status, 'PASS');
  assert.equal(existsSync(f.env.VERIFY_MARKER), true);
  assert.equal(existsSync(f.env.RELEASE_MARKER), true);
  assert.equal(existsSync(f.env.BUILD_MARKER), false);
  assert.ok(!readFileSync(f.calls, 'utf8').includes('/actions/'));
});

test('a green GitHub Verify cannot bypass a failing local release build', async t => {
  const f = await source(t, { buildFailure: true });
  const { result, receipt, output } = f.invoke([f.run], ['--tag']);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(receipt.gates.verify.runId, f.run.id);
  assert.equal(receipt.gates.verify.reason, 'release-build-failed');
  assert.equal(receipt.gates.verify.build.exitCode, 9);
  assert.equal(receipt.publicExport, null);
  assert.equal(existsSync(join(output, 'public-source.tar')), false);
  assert.equal(read(join(output, receipt.siteRelease.path)).provenance.publication, 'blocked');
});
