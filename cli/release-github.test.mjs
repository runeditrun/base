import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repository, source } from './fixtures/release-github.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));

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
  const absent = await source(t, { workflows: {} });
  const missing = absent.invoke([], [], { [`repos/${repository}/actions/workflows?per_page=100`]: [{ workflows: [] }] });
  assert.equal(missing.result.status, 1, missing.result.stdout);
  assert.match(missing.receipt.gates.verify.details, /No Verify workflow/);
  for (const [extra, reason] of [
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
