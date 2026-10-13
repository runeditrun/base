import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cli } from './helpers.mjs';
import { resolve } from 'node:path';

test('workflow security boundary: dispatch-only, no Environment before validation, isolated writers', () => {
  for (const [name, environment] of [['live-proof', 'live-proof'], ['deploy-stage', 'stage']]) {
    const text = readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    assert.match(text, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(text, /^  (push|pull_request|pull_request_target|workflow_call|schedule):/m);
    assert.match(text, /permissions:\n  contents: read/);
    const validate = text.split('  validate:')[1].split('  execute:')[0];
    const execute = text.split('  execute:')[1].split('  receipt:')[0];
    const receipt = text.split('  receipt:')[1];
    assert.doesNotMatch(validate, /environment:|secrets\./);
    assert.match(validate, /GITHUB_REF" == refs\/heads\/main/);
    assert.match(validate, /GITHUB_EVENT_NAME" == workflow_dispatch/);
    assert.match(validate, /ref: \$\{\{ github.workflow_sha \}\}/);
    assert.match(execute, new RegExp(`environment: ${environment}`));
    assert.match(execute, /ref: \$\{\{ needs.validate.outputs.sha \}\}/);
    assert.doesNotMatch(execute, /EVIDENCE_WRITE_TOKEN/);
    assert.match(receipt, /always\(\) && needs.validate.result == 'success'/);
    assert.match(receipt, /EVIDENCE_WRITE_TOKEN: \$\{\{ secrets.EVIDENCE_WRITE_TOKEN \}\}/);
    assert.doesNotMatch(receipt, /CF_THROWAWAY_|needs.validate.outputs.sha[^\n]*\n[^\n]*persist-credentials/);
    for (const action of text.matchAll(/uses: (\S+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
    assert.equal([...text.matchAll(/uses: actions\/checkout@/g)].length,
      [...text.matchAll(/persist-credentials: false/g)].length);
    assert.doesNotMatch(text, /upload-artifact|download-artifact|toJSON\(secrets\)|environment: production/);
    // User inputs are environment values only; no interpolation in shell source.
    for (const run of text.matchAll(/run: ([\s\S]*?)(?=\n      -|\n  [a-z]|$)/g))
      assert.doesNotMatch(run[1], /\$\{\{ inputs\./);
  }
});
test('source CLI rejects hostile input with a fixed diagnostic and no secret-bearing environment work', () => {
  const result = cli(resolve('live-proofs/validate-source.mjs'), {
    INPUT_SHA: '$(touch should-never-exist)', GH_READ_TOKEN: 'test-only-private-value',
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Source validation rejected the request.\n');
});
