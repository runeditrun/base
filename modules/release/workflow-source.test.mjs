import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, source } from '../../cli/fixtures/release-github.mjs';

const workflowsPath = `repos/${repository}/actions/workflows?per_page=100`;
const edition = '.github/workflows/edition.yml';

// The selected commit stays pinned while the checkout and current API list move on.
test('release gates an older commit on its renamed workflow by file or committed name', async t => {
  const f = await source(t, { workflows: { 'edition.yml': 'Verify authoritative edition source' },
    declaration: { verifyWorkflow: 'Verify authoritative edition source' } });
  renameSync(join(f.repo, edition), join(f.repo, '.github/workflows/verify.yml'));
  f.commit();
  const run = { ...f.run, path: edition + '@refs/heads/main', workflow_id: 73 };
  for (const flags of [['--verify-workflow', 'edition.yml'], []]) {
    const { result, receipt } = f.invoke([], flags, {
      [workflowsPath]: [{ workflows: [{ id: 74, name: 'Verify', path: '.github/workflows/verify.yml' }] }],
      [`repos/${repository}/actions/runs?head_sha=${f.sha}&per_page=100`]: [{ workflow_runs: [run] }],
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(receipt.gates.verify.status, 'PASS');
    assert.equal(receipt.gates.verify.workflowFile, edition);
    assert.equal(receipt.gates.verify.workflowId, run.workflow_id);
    assert.equal(receipt.gates.verify.commit, f.sha);
    assert.equal(receipt.gates.verify.runId, run.id);
  }
});

test('release refuses a current-list workflow absent from the source tree before querying runs', async t => {
  const f = await source(t);
  const { result, receipt } = f.invoke([f.run], ['--verify-workflow', 'absent.yml'], {
    [workflowsPath]: [{ workflows: [{ id: 42, name: 'Verify', path: '.github/workflows/absent.yml' }] }],
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(receipt.gates.verify.status, 'FAIL');
  assert.match(receipt.gates.verify.details, /No Verify workflow matches/);
  assert.equal(readFileSync(f.calls, 'utf8').includes('/runs?'), false);
});

test('release refuses a successful different workflow path at the same source SHA', async t => {
  const f = await source(t, { workflows: { 'edition.yml': 'Edition' } });
  const { result, receipt } = f.invoke([], ['--verify-workflow', 'edition.yml'], {
    [workflowsPath]: [{ workflows: [] }],
    [`repos/${repository}/actions/runs?head_sha=${f.sha}&per_page=100`]:
      [{ workflow_runs: [{ ...f.run, path: '.github/workflows/other.yml' }] }],
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(receipt.gates.verify.status, 'FAIL');
  assert.match(receipt.gates.verify.details, /different workflow path/);
});

test('release keeps the current-list workflow id check as well as the exact committed path', async t => {
  const f = await source(t);
  const accepted = f.invoke([f.run], ['--verify-workflow', 'Verify']);
  assert.equal(accepted.result.status, 0, accepted.result.stdout);
  assert.equal(accepted.receipt.gates.verify.workflowId, f.run.workflow_id);
  const refused = f.invoke([{ ...f.run, workflow_id: 73 }], ['--verify-workflow', 'Verify']);
  assert.equal(refused.result.status, 1, refused.result.stdout);
  assert.match(refused.receipt.gates.verify.details, /different workflow/);
});
