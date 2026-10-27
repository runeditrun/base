import { caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { source, repository } from '../../cli/fixtures/release-github.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function publishTag(f, { lightweight = false, commit = f.sha, message = 'v1.2.3', name = 'v1.2.3' } = {}) {
  if (lightweight) git(f.repo, 'tag', name, commit);
  else git(f.repo, 'tag', '-a', name, commit, '-m', message);
  const oid = git(f.repo, 'rev-parse', `refs/tags/${name}`);
  git(f.repo, 'push', f.remote, `refs/tags/${name}`);
  return oid;
}

function tagRun(f, oid) {
  return {
    [`repos/${repository}/git/ref/tags/v1.2.3`]: { object: { type: 'tag', sha: oid } },
    [`repos/${repository}/git/tags/${oid}`]: { object: { type: 'commit', sha: f.sha } },
  };
}

test('tag-first release adopts a remote annotated tag with exact source and green tag Verify', async t => {
  const f = await source(t);
  const oid = publishTag(f);
  // A fresh checkout need not already have the published tag locally.
  git(f.repo, 'tag', '-d', 'v1.2.3');
  const { result, receipt, output } = f.invoke([{ ...f.run, head_branch: 'v1.2.3' }], ['--tag', 'v1.2.3'], tagRun(f, oid), { dryRun: false });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(receipt.status, 'RELEASED');
  assert.equal(receipt.tag.adopted, true);
  assert.equal(receipt.tag.created, false);
  assert.equal(receipt.tag.object, oid);
  assert.equal(receipt.publicExport.tagObject, oid);
  assert.equal(receipt.publicExport.commit, f.sha);
  assert.equal(receipt.gates.verify.branch, 'v1.2.3');
  assert.equal(receipt.gates.publishCheck.status, 'PASS');
  assert.equal(git(f.repo, 'rev-parse', 'refs/tags/v1.2.3'), oid);
  assert.equal(git(f.remote, 'rev-parse', 'refs/tags/v1.2.3'), oid);
  assert.equal(JSON.parse(readFileSync(join(output, 'release-receipt.json'))).tag.object, oid);
  const keyPath = join(f.temporary, 'signing-key.pem');
  writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const signed = spawnSync(process.execPath, [join(import.meta.dirname, '../../bin/rer.mjs'), 'release', 'sign',
    '--artifact', output, '--key-file', keyPath, '--scope', 'test'], { env: f.env, encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /^gh release upload/);
});

test('tag-first release retains a matching local annotation and exact public notes', async t => {
  const f = await source(t);
  const notes = 'Ship the café update.\n\n# Public details\nPreserve this paragraph.';
  writeFileSync(join(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: `  ${notes}\n` }));
  // Select the new commit through an explicit --ref just as an operator does.
  const commit = f.commit();
  git(f.repo, 'tag', '-a', '--cleanup=verbatim', 'v1.2.3', commit, '-m', `v1.2.3\n\n${notes}\n`);
  const oid = git(f.repo, 'rev-parse', 'v1.2.3');
  git(f.repo, 'push', f.remote, 'refs/tags/v1.2.3');
  const runsPath = `repos/${repository}/actions/workflows/42/runs?head_sha=${commit}&per_page=100`;
  const extra = { ...tagRun(f, oid),
    [runsPath]: [{ workflow_runs: [{ ...f.run, head_sha: commit, head_branch: 'v1.2.3' }] }],
    [`repos/${repository}/git/tags/${oid}`]: { object: { type: 'commit', sha: commit } } };
  const result = f.invoke([], ['--tag', 'v1.2.3', '--ref', commit], extra, { dryRun: false });
  assert.equal(result.result.status, 0, result.result.stdout);
  assert.equal(result.receipt.tag.object, oid);
  assert.equal(result.receipt.tag.created, false);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3'), oid);
});

test('tag-first release refuses invalid existing tags without changing their identity', async t => {
  await caseRows(t, await (async () => {
    const rows = [];
    for (const [name, options, reason] of [
    ['lightweight', { lightweight: true }, /annotated tag/],
    ['other commit', { otherCommit: true }, /exact source commit/],
    ['message mismatch', { message: 'v1.2.3\n\nDifferent release notes.' }, /message/],
    ['embedded name mismatch', { alias: true }, /name.*version/],
    ['requested version mismatch', { requested: 'v1.2.4' }, /match.*version/],
  ]) await rows.push([name, async t => {
    const f = await source(t);
    if (options.otherCommit) options.commit = git(f.repo, 'rev-parse', 'HEAD^');
    const oid = publishTag(f, { ...options, name: options.alias ? 'v9.9.9' : 'v1.2.3' });
    if (options.alias) git(f.repo, 'push', f.remote, `${oid}:refs/tags/v1.2.3`);
    const before = git(f.remote, 'show-ref', '--tags');
    const { result, receipt } = f.invoke([{ ...f.run, head_branch: 'v1.2.3' }], ['--tag', options.requested ?? 'v1.2.3'], tagRun(f, oid), { dryRun: false, validationError: true });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(receipt, null);
    assert.match(result.stderr, reason);
    assert.equal(git(f.remote, 'show-ref', '--tags'), before);
  }]);
    return rows;
  })());
});

test('release branch Verify authorizes tag creation and adoption at the exact source commit', async t => {
  const f = await source(t);
  const branchRun = [{ ...f.run, head_branch: 'release/v1.2.3' }];
  const noTag = f.invoke(branchRun, ['--tag', 'v1.2.3'], {}, { dryRun: false });
  assert.equal(noTag.result.status, 0, noTag.result.stdout);
  assert.equal(noTag.receipt.status, 'RELEASED');
  assert.equal(noTag.receipt.gates.verify.runId, f.run.id);
  assert.equal(noTag.receipt.tag.created, true);
  const oid = git(f.repo, 'rev-parse', 'refs/tags/v1.2.3');
  assert.equal(noTag.receipt.publicExport.tagObject, oid);
  git(f.repo, 'push', f.remote, 'refs/tags/v1.2.3');
  const tagged = f.invoke(branchRun, ['--tag', 'v1.2.3'], tagRun(f, oid), { dryRun: false });
  assert.equal(tagged.result.status, 0, tagged.result.stdout);
  assert.equal(tagged.receipt.status, 'RELEASED');
  assert.equal(tagged.receipt.gates.verify.runId, f.run.id);
  assert.equal(tagged.receipt.tag.adopted, true);
  assert.equal(tagged.receipt.tag.created, false);
  assert.equal(tagged.receipt.tag.object, oid);
  assert.equal(tagged.receipt.publicExport.tagObject, oid);
  assert.equal(git(f.remote, 'rev-parse', 'refs/tags/v1.2.3'), oid);
});
