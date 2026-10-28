import { runRows } from '../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execute } from '../run.mjs';
import { fixture, commit, cli } from './helpers.mjs';
const proofRows = []
const env = { PATH: process.env.PATH, CF_THROWAWAY_API_TOKEN: 'test-only-provider',
  CF_THROWAWAY_ACCOUNT_ID: 'test-only-account', EVIDENCE_WRITE_TOKEN: 'test-only-store' };
proofRows.push(['proof rejects unknown and missing names; subprocess sees providers but no evidence token', {}, t => {
  const f = fixture(t); mkdirSync(join(f.source, 'live-proofs'));
  writeFileSync(join(f.source, 'live-proofs/secrets-present.mjs'), `import fs from 'node:fs';
    if(process.env.EVIDENCE_WRITE_TOKEN || !process.env.CF_THROWAWAY_API_TOKEN) process.exit(2);
    fs.writeFileSync('ran','yes'); console.log('test-only-provider');`);
  const sha = commit(f.source, 'proof');
  const base = { root: f.source, sha, mode: 'proof', proof: 'secrets-present', env };
  assert.throws(() => execute({ ...base, proof: 'unknown' }), /unknown-proof/);
  assert.equal(execute({ ...base, env: { ...env, CF_THROWAWAY_API_TOKEN: '' } }), 'missing-secret');
  assert.equal(existsSync(join(f.source, 'ran')), false);
  assert.equal(execute(base), 'passed');
  assert.equal(readFileSync(join(f.source, 'ran'), 'utf8'), 'yes');
  assert.throws(() => execute({ ...base, sha: 'a'.repeat(40) }), /checkout-mismatch/);
  const output = join(f.root, 'output'); writeFileSync(output, '');
  const result = cli(resolve('live-proofs/run.mjs'), { ...env, SOURCE_DIRECTORY: f.source,
    VALIDATED_SHA: sha, MODE: 'proof', INPUT_PROOF: 'secrets-present', GITHUB_OUTPUT: output });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'CF_THROWAWAY_API_TOKEN\nCF_THROWAWAY_ACCOUNT_ID\n');
  assert.equal(result.stderr, '');
}]);
proofRows.push(['secrets-present direct entrypoint prints names only and fails each missing secret', {}, () => {
  const script = resolve('live-proofs/secrets-present.mjs');
  assert.equal(cli(script, env).status, 0);
  for (const name of ['CF_THROWAWAY_API_TOKEN', 'CF_THROWAWAY_ACCOUNT_ID']) {
    const result = cli(script, { ...env, [name]: '' });
    assert.equal(result.status, 1); assert.ok(!result.stdout.includes('test-only'));
    assert.ok(!result.stdout.includes('EVIDENCE_WRITE_TOKEN'));
  }
}]);
test('stage is honestly blocked; real command failures gate health and report failures', t => {
  const f = fixture(t);
  const base = { root: f.source, sha: f.sha, mode: 'stage', env };
  assert.equal(execute(base), 'stage-target-unconfigured');
  const deploy = join(f.source, 'deploy.mjs'), health = join(f.source, 'health.mjs');
  writeFileSync(deploy, `import fs from 'node:fs'; fs.writeFileSync('deployed','yes'); process.exit(3);`);
  writeFileSync(health, `import fs from 'node:fs'; fs.writeFileSync('checked','yes'); process.exit(4);`);
  const adapter = { blocked: null, cwd: '.', deploy: [process.execPath, deploy], health: [process.execPath, health] };
  assert.equal(execute({ ...base, adapter }), 'deploy-failed');
  assert.equal(existsSync(join(f.source, 'checked')), false);
  writeFileSync(deploy, 'process.exit(0);');
  assert.equal(execute({ ...base, adapter }), 'health-failed');
  writeFileSync(health, 'process.exit(0);');
  assert.equal(execute({ ...base, adapter }), 'passed');
});

test("proof admission requires provider credentials and isolates evidence authority", async t => {
  await runRows(t, proofRows)
})
