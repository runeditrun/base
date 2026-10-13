import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, cleanEnvironment } from './commands.mjs';
import { ciMetadata } from './metadata.mjs';
import { Receipt, hash } from './receipt.mjs';
import { PROOFS, EVIDENCE } from './constants.mjs';
import { artifactAdversary } from './artifact-adversary.mjs';
import { tarEntry } from './archive-fixtures.mjs';
import { unpackArtifact } from '../../t016/artifact.mjs';
const scratch = () => mkdtempSync(join(tmpdir(), 't016-controls-'));
const commit = 'a'.repeat(40);
const github = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'runeditrun/base', GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW_SHA: 'b'.repeat(40), GITHUB_SHA: 'c'.repeat(40), GITHUB_JOB: 'qualification', GITHUB_SERVER_URL: 'https://github.com' };
const event = () => ({ repository: { full_name: 'runeditrun/base', private: true }, pull_request: { number: 3, head: { sha: commit, repo: { full_name: 'runeditrun/base', private: true } }, base: { repo: { full_name: 'runeditrun/base', private: true } } } });
test('CI identity binds actual head and separately records workflow revision', () => {
  const got = ciMetadata(github, event(), commit); assert.equal(got.headSha, commit); assert.equal(got.workflowSha, github.GITHUB_WORKFLOW_SHA);
  for (const mutate of [e => e.repository.private = false, e => e.pull_request.head.repo.full_name = 'fork/base', e => e.pull_request.head.sha = 'd'.repeat(40)]) {
    const e = event(); mutate(e); assert.throws(() => ciMetadata(github, e, commit));
  }
  assert.throws(() => ciMetadata({ ...github, GITHUB_EVENT_NAME: 'pull_request_target' }, event(), commit));
  assert.throws(() => ciMetadata({ ...github, GITHUB_WORKFLOW_SHA: '' }, event(), commit));
});
test('clean subprocess environment never inherits provider or npm authority', () => {
  const env = cleanEnvironment('/test', '/bin'); assert.deepEqual(Object.keys(env).filter(k => /TOKEN|SECRET|API_KEY|PASSWORD/.test(k)), []);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(env.HOME, '/test'); assert(!('NODE_OPTIONS' in env));
});
test('actual commands preserve failures, bounded output and process timeout', async () => {
  const env = cleanEnvironment(tmpdir());
  const fail = await execute([process.execPath, '-e', 'console.error("expected failure"); process.exit(23)'], { env });
  assert.equal(fail.exitCode, 23); assert.match(fail.stderr.toString(), /expected failure/); assert.equal(fail.timedOut, false);
  const timeout = await execute([process.execPath, '-e', 'setInterval(()=>{},1000)'], { env, timeout: 100 }); assert.equal(timeout.timedOut, true); assert.notEqual(timeout.exitCode, 0);
  const overflow = await execute([process.execPath, '-e', 'console.log("x".repeat(10000))'], { env, limit: 20 }); assert.equal(overflow.overflow, true);
});
test('real strict unpacker accepts regular bytes and rejects link/traversal/config targets', () => {
  const root = scratch();
  try {
    const receipt = new Receipt(join(root, 'reports'), {});
    artifactAdversary({ root, receipt });
    const ok = join(root, 'good'); mkdirSync(ok); const files = unpackArtifact(tarEntry('payload'), ok, 'dist');
    assert.equal(files[0].sha256, hash('test')); assert.equal(readFileSync(join(ok, 'dist/payload'), 'utf8'), 'test');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('receipt cannot pass missing proofs, missing evidence, or image custody', async () => {
  const root = scratch();
  try {
    const receipt = new Receipt(root, {}); assert.equal(receipt.finish().status, 'incomplete');
    receipt.value.commands = [];
    for (const id of PROOFS) await receipt.proof(id, () => {});
    assert.equal(receipt.finish().status, 'incomplete');
    receipt.file('observation.json', { fixture: true }, EVIDENCE);
    assert.equal(receipt.finish().status, 'incomplete');
    receipt.value.imageCustody = { status: 'prepared-for-private-upload' };
    assert.equal(receipt.finish().status, 'pass');
    await receipt.proof('unexpected-failure', () => { throw new Error('assertion failed'); }); assert.equal(receipt.finish().status, 'fail');
    for (const [name, info] of Object.entries(receipt.value.files)) assert.equal(hash(readFileSync(join(root, name))), info.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('synthetic marker redaction is enforced for text and binary retention', () => {
  const root = scratch();
  try {
    const receipt = new Receipt(root, {}); receipt.secrets.push('random-test-marker');
    receipt.file('redacted.log', 'x random-test-marker y'); assert(!readFileSync(join(root, 'redacted.log'), 'utf8').includes('random-test-marker'));
    assert.throws(() => receipt.file('binary', Buffer.from('random-test-marker')));
    assert.throws(() => receipt.file('../escape', 'bad'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('new generic fixtures use committed blobs, varied credential/cwd and reviewed literal commands', async () => {
  const { genericFixture } = await import('./generic-fixture.mjs');
  const { snapshotSource, reviewDescriptor } = await import('../../standalone/review.mjs');
  const root = scratch();
  try {
    const receipt = new Receipt(join(root, 'reports'), {}), env = cleanEnvironment(root);
    const ctx = { root, checkout: process.cwd(), receipt, env, images: {} };
    const fixture = await genericFixture(ctx, 'success');
    const review = reviewDescriptor(fixture.descriptor, fixture.adapter);
    assert.equal(review.names.length, 1); assert.match(review.names[0], /^PROOF_[A-F0-9]+_CREDENTIAL$/);
    assert.deepEqual(review.commands[1].argv, fixture.descriptor.commands.deploy.argv);
    const destination = join(root, 'committed');
    await snapshotSource({ directory: fixture.directory, sourceSha: fixture.adapter.sourceSha, destination, env });
    assert.match(readFileSync(join(destination, fixture.cwd, 'build.mjs'), 'utf8'), /actual-pnpm-postinstall/);
    assert.match(readFileSync(join(fixture.directory, fixture.cwd, 'build.mjs'), 'utf8'), /dirty-worktree-executed/);
    for (const file of ['setup.mjs', 'deploy.mjs', 'probe.mjs', 'install.mjs', 'build.mjs', 'mutate.mjs']) {
      const result = await execute([process.execPath, '--check', join(destination, fixture.cwd, file)], { env }); assert.equal(result.exitCode, 0, result.stderr.toString());
    }
    const { existsSync } = await import('node:fs'); assert(!existsSync(join(destination, 'ignored-secret'))); assert(!existsSync(join(destination, 'untracked')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
