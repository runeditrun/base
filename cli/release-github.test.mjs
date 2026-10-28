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
    ['wrong repository', { repository: { full_name: 'other/source' } }, /different source repository/],
    ['wrong workflow', { workflow_id: 43 }, /different workflow/],
    ['pull request merge ref', { event: 'pull_request' }, /event/],
  ]) await t.test(name, () => {
    const { result, receipt } = f.invoke(patch ? [{ ...f.run, ...patch }] : []);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(receipt.gates.verify.status, 'FAIL');
    assert.match(receipt.gates.verify.details, reason);
    assert.ok(receipt.gates.verify.message.includes(f.sha));
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
  const token = ['gh', 'p_'].join('') + 'synthetic-base-1';
  for (const [name, stderr, expected] of [
    ['rate limit', 'HTTP 403: API rate limit exceeded', /HTTP 403: API rate limit exceeded/],
    ['token redaction', token, /\[REDACTED\]/],
    ['empty stderr', '', /Check gh authentication and repository access/],
    ['header redaction', 'Authorization: Bearer synthetic-base-2', /\[REDACTED\]/],
    ['bounded stderr', 'synthetic-base-3 '.repeat(1000), /synthetic-base-3/],
  ]) await t.test(name, () => {
    const { result, receipt } = f.invoke([], [], {}, { ghFailure: { status: 1, stderr } });
    const gate = receipt.gates.verify;
    assert.equal(result.status, 1);
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(gate.status, 'FAIL');
    assert.equal(gate.reason, 'github-verify-unavailable');
    assert.match(gate.details, /^gh exited with status 1: /);
    assert.match(gate.details, expected);
    assert.ok(gate.details.length <= 'gh exited with status 1: '.length + 8192);
    assert.ok(!JSON.stringify(receipt).includes(token));
    assert.ok(!gate.details.includes('synthetic-base-2'));
    assert.equal(receipt.publicExport, null);
    assert.equal(existsSync(f.env.BUILD_MARKER), false);
    assert.equal(existsSync(f.env.VERIFY_MARKER), false);
    if (name !== 'bounded stderr') t.diagnostic(JSON.stringify({ scenario: name, status: receipt.status, verify: gate }));
  });
});

test('rer release accepts exact-SHA branch Verify despite a failed default-branch duplicate', async t => {
  const f = await source(t);
  const green = { ...f.run, id: 40040194727, head_branch: 'sd-penny-rel6' };
  const failed = { ...f.run, id: 40041446585, conclusion: 'failure' };
  for (const runs of [[failed, green], [green, failed]]) {
    const { result, receipt, output } = f.invoke(runs);
    assert.equal(result.status, 0, result.stdout);
    const gate = receipt.gates.verify;
    assert.equal(gate.status, 'PASS');
    assert.equal(gate.runId, green.id);
    assert.equal(gate.branch, green.head_branch);
    assert.equal(gate.event, green.event);
    assert.equal(gate.runUrl, `https://github.com/${repository}/actions/runs/${green.id}`);
    assert.equal(gate.information.length, 1);
    assert.equal(gate.information[0].runId, failed.id);
    assert.equal(gate.information[0].conclusion, failed.conclusion);
    assert.equal(read(join(output, receipt.siteRelease.path)).provenance.gates.verify.information[0].runId, failed.id);
  }
});

test('rer release refuses successful branch Verify from a fork or a nearly matching SHA', async t => {
  const f = await source(t);
  const branch = { ...f.run, head_branch: 'feature' };
  for (const run of [
    { ...branch, head_repository: { full_name: 'fork/Hello-World' } },
    { ...branch, head_sha: (f.sha[0] === 'a' ? 'b' : 'a') + f.sha.slice(1) },
  ]) {
    const { result, receipt } = f.invoke([run]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(receipt.gates.verify.status, 'FAIL');
    assert.equal(receipt.publicExport, null);
    assert.equal(existsSync(f.env.BUILD_MARKER), false);
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
