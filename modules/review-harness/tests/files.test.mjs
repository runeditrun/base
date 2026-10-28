import { namedSteps } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stat, readFile, chmod } from 'node:fs/promises';
import { privateDirectory, privateFile } from '../files.mjs';
import { writeReport } from '../report.mjs';
import { redact, safeUrl, sanitize } from '../privacy.mjs';
import { temporary } from './helpers.mjs';

test("private evidence writes preserve mode and atomically replace previous bytes", async t => {
  const step = namedSteps(t);
  await step('evidence files are 0600 and nested directories are 0700', async t => {
    const root = await temporary(t);
    const directory = await privateDirectory(join(root, 'evidence', 'nested'));
    const path = join(directory, 'file');
    await privateFile(path, 'synthetic');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, '..'))).mode & 0o777, 0o700);
  });

  await step('later evidence writes atomically replace old files with private bytes', async t => {
    const root = await temporary(t);
    const file = join(root, 'evidence');
    await privateFile(file, 'old');
    await chmod(file, 0o644);
    await privateFile(file, 'new');
    assert.equal(await readFile(file, 'utf8'), 'new');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
})

test('diagnostics redact literal secrets and token query values; report paths strip tokens', () => {
  assert.equal(redact('synthetic-private-value token=synthetic-query&next=safe', ['synthetic-private-value']), '[redacted] token=[redacted]&next=safe');
  assert.equal(safeUrl('http://127.0.0.1:1234/app?Token=synthetic-query&view=review#private', [], true), '/app?view=review');
  assert.deepEqual(sanitize({ text: ['synthetic-private-value'] }, ['synthetic-private-value']), { text: ['[redacted]'] });
});

test('report keeps failing totals, writes on failure, and never serializes registered values', async t => {
  const evidence = await temporary(t);
  const report = { schemaVersion: 2, capturePolicy: 'failures', historyLimit: 2, startedAt: new Date().toISOString(), finishedAt: null, captures: [{ gate: { passed: false, failures: ['keyboard'] } }, { gate: { passed: true, failures: [] } }], errors: ['synthetic-private-value'], totals: null, passed: false };
  const path = await writeReport(evidence, report, ['synthetic-private-value']);
  const result = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(result.totals, { captures: 2, passed: 1, failed: 1 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.errors, ['[redacted]']);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  report.errors = [];
  const gateOnly = JSON.parse(await readFile(await writeReport(join(evidence, 'gate-only'), report), 'utf8'));
  assert.equal(gateOnly.passed, false, 'gate failure alone makes the run fail');
});
