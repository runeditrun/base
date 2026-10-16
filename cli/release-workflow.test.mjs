import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repository, source } from './fixtures/release-github.mjs';

const workflowsPath = `repos/${repository}/actions/workflows?per_page=100`;
const spool = { id: 42, name: 'verify', path: '.github/workflows/verify.yml' };
const slate = { id: 42, name: 'Verify Slate', path: '.github/workflows/verify.yml' };
const selectedRuns = (f, workflow) => ({
  [`repos/${repository}/actions/workflows/${workflow.id}/runs?head_sha=${f.sha}&per_page=100`]:
    [{ workflow_runs: [{ ...f.run, workflow_id: workflow.id }] }],
});

test('rer release finds Spool and Slate by conventional workflow file, before workflow name', async t => {
  const f = await source(t);
  for (const workflow of [spool, slate, { ...slate, path: '.github/workflows/VERIFY.YAML' }]) {
    const { result, receipt } = f.invoke([f.run], [], {
      [workflowsPath]: [{ workflows: [workflow, { id: 43, name: 'Verify', path: '.github/workflows/other.yml' }] }],
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(receipt.gates.verify.workflowFile, workflow.path);
    assert.equal(receipt.gates.verify.workflowName, workflow.name);
    assert.equal(receipt.gates.verify.runId, f.run.id);
  }
});

test('rer release uses a committed declaration by name or file, before the conventional file', async t => {
  for (const selector of ['vErIfY sLaTe', '.GITHUB/WORKFLOWS/SLATE.YAML', 'SLATE.yaml']) {
    const f = await source(t, { declaration: { verifyWorkflow: selector } });
    const workflow = { ...slate, id: 43, path: '.github/workflows/slate.yaml' };
    const { result, receipt } = f.invoke([], [], {
      [workflowsPath]: [{ workflows: [spool, workflow] }], ...selectedRuns(f, workflow),
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(receipt.gates.verify.workflowId, workflow.id);
    assert.equal(receipt.gates.verify.workflowFile, workflow.path);
  }
});

test('rer release uses a single case-insensitive Verify name when no declaration or conventional file exists', async t => {
  const f = await source(t);
  const workflow = { ...spool, name: 'vErIfY', path: '.github/workflows/check.yml' };
  const { result, receipt } = f.invoke([f.run], [], { [workflowsPath]: [{ workflows: [workflow] }] });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(receipt.gates.verify.workflowFile, workflow.path);
});

test('rer release refuses ambiguous workflows with both candidates and an explicit selection remedy', async t => {
  const f = await source(t);
  const workflows = [
    { ...spool, name: 'Verify', path: '.github/workflows/check.yml' },
    { ...spool, id: 43, path: '.github/workflows/test.yml' },
  ];
  const { result, receipt } = f.invoke([f.run], [], { [workflowsPath]: [{ workflows }] });
  assert.equal(result.status, 1, result.stdout);
  const details = receipt.gates.verify.details;
  for (const workflow of workflows) assert.ok(details.includes(`${workflow.name} (${workflow.path})`), details);
  assert.match(details, /--verify-workflow/);
  assert.equal(readFileSync(f.calls, 'utf8').includes('/runs?'), false);
});

test('rer release --verify-workflow wins over a declaration and conventional file by name or file', async t => {
  const f = await source(t, { declaration: { verifyWorkflow: 'verify' } });
  const workflow = { id: 43, name: 'Verify candidate', path: '.github/workflows/candidate.yml' };
  for (const selector of ['vErIfY cAnDiDaTe', '.GITHUB/WORKFLOWS/CANDIDATE.YML', 'CANDIDATE.yml']) {
    const { result, receipt } = f.invoke([], ['--verify-workflow', selector], {
      [workflowsPath]: [{ workflows: [spool, workflow] }], ...selectedRuns(f, workflow),
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(receipt.gates.verify.workflowId, workflow.id);
    assert.equal(receipt.gates.verify.workflowName, workflow.name);
  }
});

test('rer release refuses unmatched or malformed authoritative selectors without falling through', async t => {
  for (const selector of ['missing.yml', '', null, 42]) {
    const f = await source(t, { declaration: { verifyWorkflow: selector } });
    const { result, receipt } = f.invoke([f.run], [], { [workflowsPath]: [{ workflows: [spool] }] });
    assert.equal(result.status, 1, result.stdout);
    assert.match(receipt.gates.verify.details, /--verify-workflow/);
    assert.equal(readFileSync(f.calls, 'utf8').includes('/runs?'), false);
  }
  const f = await source(t);
  const { result } = f.invoke([f.run], ['--verify-workflow', 'missing.yml'], { [workflowsPath]: [{ workflows: [spool] }] });
  assert.equal(result.status, 1, result.stdout);
});
