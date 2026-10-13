import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeReceipt } from '../receipt.mjs';
import { persistToGit } from '../git-store.mjs';
import { evidenceRepository } from '../policy.mjs';
import { fixture, git, commit, wrapper, cli } from './helpers.mjs';
const now = '2026-10-06T01:02:03.000Z';
function receipt(f, overrides = {}) {
  return makeReceipt({ VALIDATED_SHA: f.sha, CONTROL_SHA: f.sha,
    GITHUB_REPOSITORY: 'runeditrun/base', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    MODE: 'proof', INPUT_PROOF: 'secrets-present', JOB_RESULT: 'success', EXECUTION_RESULT: 'passed',
    EXECUTED_SHA: f.sha, STARTED: now, FINISHED: now, ...overrides }, now);
}
test('appends success and failure receipts, preserves previous evidence and refuses overwrite', t => {
  const f = fixture(t);
  commit(f.source, 'prior-receipt.json', '{"prior":true}'); git(f.source, 'push', f.remote, 'main');
  const first = receipt(f);
  const path = persistToGit(first, { remote: f.remote, tempRoot: f.root });
  assert.deepEqual(JSON.parse(git(f.root, '--git-dir', f.remote, 'show', `main:${path}`)), first);
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:prior-receipt.json'), '{"prior":true}');
  assert.throws(() => persistToGit(first, { remote: f.remote, tempRoot: f.root }), /already-exists/);
  const failure = receipt(f, { GITHUB_RUN_ATTEMPT: '2', JOB_RESULT: 'failure', EXECUTION_RESULT: 'missing-secret' });
  const second = persistToGit(failure, { remote: f.remote, tempRoot: f.root });
  assert.equal(JSON.parse(git(f.root, '--git-dir', f.remote, 'show', `main:${second}`)).result, 'failed');
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', `main:${path}`), JSON.stringify(first, null, 2));
});
test('rejects arbitrary payload, path, command, repository, run identifier and result injection', t => {
  const f = fixture(t);
  for (const change of [{ payload: 'private bytes' }, { runId: '../escape' }, { repository: 'just-every/run-lamp' },
    { commands: [['sh', '-c', 'echo private']] }, { workflow: '../../bad' }, { failureStatus: 'provider secret' }])
    assert.throws(() => persistToGit({ ...receipt(f), ...change }, { remote: f.remote, tempRoot: f.root }));
  const path = join(f.root, 'never');
  const output = cli(resolve('live-proofs/persist.mjs'), { EVIDENCE_WRITE_TOKEN: '', RUNNER_TEMP: path });
  assert.equal(output.status, 1); assert.equal(existsSync(path), false);
  assert.equal(output.stderr, 'Receipt persistence failed.\n');
});
test('failed pushes fail and preserve remote evidence without a fallback', t => {
  const f = fixture(t); const before = git(f.root, '--git-dir', f.remote, 'rev-parse', 'main');
  const env = wrapper(f.root, `if(args.includes('push')) { console.error('test-only-sensitive-provider-error'); process.exit(1); }`);
  assert.throws(() => persistToGit(receipt(f), { remote: f.remote, tempRoot: f.root, env }), /receipt-push-failed/);
  assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'main'), before);
});
test('existing parent file cannot be replaced by receipt directory', t => {
  const f = fixture(t); commit(f.source, '3-foundation', 'keep me'); git(f.source, 'push', f.remote, 'main');
  assert.throws(() => persistToGit(receipt(f), { remote: f.remote, tempRoot: f.root }), /path-conflict/);
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:3-foundation'), 'keep me');
});
test('concurrent writers append both receipts without losing a remote commit', async t => {
  const f = fixture(t);
  const marker = join(f.root, 'ready-');
  const env = wrapper(f.root, `if(args.includes('push') && !fs.existsSync(${JSON.stringify(marker)}+process.env.WRITER_ID)) {
    fs.writeFileSync(${JSON.stringify(marker)}+process.env.WRITER_ID,'ready');
    const start=Date.now(); while(!(fs.existsSync(${JSON.stringify(marker)}+'1')&&fs.existsSync(${JSON.stringify(marker)}+'2'))) {
      if(Date.now()-start>10000) process.exit(9); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
  }`);
  const script = join(f.root, 'write.mjs');
  writeFileSync(script, `import {persistToGit} from ${JSON.stringify(new URL('../git-store.mjs', import.meta.url).href)};
    const receipt=JSON.parse(process.env.RECEIPT);
    persistToGit(receipt,{remote:process.env.REMOTE,tempRoot:process.env.TEMP_ROOT});`);
  const run = id => new Promise((yes, no) => {
    const child = spawn(process.execPath, [script], { env: { ...env, WRITER_ID: id,
      RECEIPT: JSON.stringify(receipt(f, { GITHUB_RUN_ID: id })), REMOTE: f.remote, TEMP_ROOT: f.root }, stdio: 'pipe' });
    let error = ''; child.stderr.on('data', x => error += x);
    child.on('error', no); child.on('exit', code => code === 0 ? yes() : no(new Error(error)));
  });
  await Promise.all([run('1'), run('2')]);
  for (const id of ['1', '2']) assert.equal(JSON.parse(git(f.root, '--git-dir', f.remote, 'show',
    `main:3-foundation/T-002b/runeditrun--base/live-proof/${id}-1.json`)).runId, id);
  assert.equal(git(f.root, '--git-dir', f.remote, 'show', 'main:README'), 'initial');
});
test('checkout failure and stage blocked status are failed receipts with honest command lists', t => {
  const f = fixture(t);
  const checkout = receipt(f, { EXECUTED_SHA: '', JOB_RESULT: 'failure', EXECUTION_RESULT: '', STARTED: '', FINISHED: '' });
  assert.equal(checkout.executedSha, null); assert.deepEqual(checkout.commands, []); assert.equal(checkout.result, 'failed');
  assert.throws(() => receipt(f, { MODE: 'stage' }), /invalid-result/);
  const stage = receipt(f, { MODE: 'stage', JOB_RESULT: 'failure', EXECUTION_RESULT: 'stage-target-unconfigured' });
  assert.equal(stage.failureStatus, 'stage-target-unconfigured'); assert.deepEqual(stage.commands, []);
  persistToGit(stage, { remote: f.remote, tempRoot: f.root });
});

test('evidence symlink parents are rejected without writing outside the store', t => {
  const f = fixture(t); symlinkSync(f.root, join(f.source, '3-foundation'));
  git(f.source, 'add', '3-foundation'); git(f.source, 'commit', '-m', 'symlink fixture');
  git(f.source, 'push', f.remote, 'main');
  assert.throws(() => persistToGit(receipt(f), { remote: f.remote, tempRoot: f.root }), /path-conflict/);
  assert.equal(existsSync(join(f.root, 'T-002b')), false);
});

test('receipt destination comes only from explicit trusted environment configuration', () => {
  for (const value of [undefined, '', '/tmp/store', 'https://example.invalid/store.git', 'https://token@github.com/runeditrun/base.git', 'https://github.com/runeditrun/base.git?token=value'])
    assert.throws(() => evidenceRepository({EVIDENCE_REPOSITORY:value}), /evidence-repository/);
  const url = new URL('https://github.com/runeditrun/base.git');
  assert.equal(evidenceRepository({EVIDENCE_REPOSITORY:url.href}), url.href);
});
