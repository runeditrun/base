import test from 'node:test';
import assert from 'node:assert/strict';
import { repository, source } from '../../cli/fixtures/release-github.mjs';

const branchPath = branch => `repos/${repository}/git/matching-refs/heads/${encodeURIComponent(branch)}`;
const tagPath = `repos/${repository}/git/matching-refs/tags/v1.2.3`;
const head = sha => ({ object: { type: 'commit', sha } });
const branchHead = (branch, sha) => [{ ref: `refs/heads/${branch}`, ...head(sha) }];

test('exported rer release accepts exact-commit Verify from authorized release branches and reports the branch', async t => {
  const f = await source(t, { portable: true });
  for (const branch of ['release/v0.4', 'release/v0', 'release/0.4.x']) {
    const { result, receipt } = f.invoke([{ ...f.run, head_branch: branch }], [], {
      [branchPath(branch)]: branchHead(branch, f.sha),
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(receipt.gates.verify.status, 'PASS');
    assert.equal(receipt.gates.verify.commit, f.sha);
    assert.equal(receipt.gates.verify.branch, branch);
    assert.equal(receipt.gates.verify.runId, f.run.id);
  }
});

test('rer release refuses other branches and a release branch whose remote head moved without a pinned tag', async t => {
  const f = await source(t);
  for (const branch of ['feature/x', 'release/v0.4-extra', 'release/v0.4/feature', 'release/0.4', 'release/v0.4.5']) {
    const { result, receipt } = f.invoke([{ ...f.run, head_branch: branch }]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(receipt.gates.verify.details, 'neither default branch nor release tag');
  }
  for (const tags of [[], [{ ref: 'refs/tags/v1.2.30', ...head(f.sha) }], [{ ref: 'refs/tags/v1.2.3', ...head('b'.repeat(40)) }]]) {
    const { result, receipt } = f.invoke([{ ...f.run, head_branch: 'release/v0.4' }], [], {
      [branchPath('release/v0.4')]: branchHead('release/v0.4', 'a'.repeat(40)), [tagPath]: tags,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(receipt.gates.verify.details, /release branch head.*points at a different commit/);
    assert.equal(receipt.publicExport, null);
  }
});

test('rer release accepts a moved release branch only when the release tag pins the verified commit', async t => {
  const f = await source(t);
  const annotation = 'c'.repeat(40);
  const { result, receipt } = f.invoke([{ ...f.run, head_branch: 'release/v0.4', event: 'workflow_dispatch' }], [], {
    [branchPath('release/v0.4')]: branchHead('release/v0.4', 'a'.repeat(40)),
    [tagPath]: [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: annotation } }],
    [`repos/${repository}/git/tags/${annotation}`]: head(f.sha),
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(receipt.gates.verify.branch, 'release/v0.4');
  assert.equal(receipt.gates.verify.event, 'workflow_dispatch');
});

test('release branch Verify retains every existing run trust check', async t => {
  const f = await source(t);
  for (const [patch, reason] of [
    [{ head_sha: 'a'.repeat(40) }, /different source SHA/],
    [{ repository: { full_name: 'other/source' } }, /different source repository/],
    [{ head_repository: { full_name: 'other/source' } }, /different source repository/],
    [{ workflow_id: 43 }, /different workflow/],
    [{ event: 'pull_request' }, /event must be push or workflow_dispatch/],
    [{ status: 'in_progress' }, /run not completed/],
    [{ conclusion: 'failure' }, /conclusion failure/],
  ]) {
    const { result, receipt } = f.invoke([{ ...f.run, head_branch: 'release/v0.4', ...patch }], [], {
      [branchPath('release/v0.4')]: branchHead('release/v0.4', f.sha),
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(receipt.gates.verify.details, reason);
    assert.equal(receipt.publicExport, null);
  }
});
