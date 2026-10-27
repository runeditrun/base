import { runRows } from '../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSource } from '../validate-source.mjs';
import { fixture, git, commit, wrapper } from './helpers.mjs';

const sourceRows = []
const options = f => ({ cwd: f.controller, sha: f.sha, dispatchSha: f.sha,
  dispatchRef: 'refs/heads/main', event: 'workflow_dispatch', repo: 'runeditrun/base',
  mode: 'proof', proof: 'secrets-present', remote: f.remote });
sourceRows.push(['fresh main ancestry and annotated release tags accepted without executing source', {}, t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'malicious.mjs'), 'throw new Error("must not run")');
  const main = commit(f.source, 'main-work'); git(f.source, 'push', f.remote, 'main');
  assert.equal(validateSource(options(f)), f.sha);
  git(f.source, 'checkout', '--orphan', 'release'); git(f.source, 'rm', '-rf', '.');
  const release = commit(f.source, 'release'); git(f.source, 'tag', '-a', 'v1.0.0', '-m', 'release');
  git(f.source, 'push', f.remote, 'v1.0.0');
  assert.equal(validateSource({ ...options(f), sha: release }), release);
  assert.equal(validateSource({ ...options(f), sha: main, mode: 'stage' }), main);
}]);
sourceRows.push(['rejects SHA expressions, names, options, injection and unknown proof before fetch', {}, t => {
  const f = fixture(t);
  for (const sha of ['main', f.sha.slice(0, 12), `${f.sha}^`, '--help', '$(touch injected)', `${f.sha}\n`, 'A'.repeat(40)])
    assert.throws(() => validateSource({ ...options(f), sha }), /invalid-sha/);
  for (const proof of ['unknown', 'toString', '__proto__', 'secrets-present; touch injected'])
    assert.throws(() => validateSource({ ...options(f), proof }), /unknown-proof/);
  for (const change of [{ dispatchRef: 'refs/heads/task' }, { dispatchRef: 'refs/tags/v1' },
    { event: 'push' }, { repo: 'just-every/run-lamp' }])
    assert.throws(() => validateSource({ ...options(f), ...change }), /invalid-dispatch/);
}]);
sourceRows.push(['rejects unrelated SHA, blob, stale tags, and workflow SHA outside main', {}, t => {
  const f = fixture(t);
  git(f.source, 'checkout', '--orphan', 'other'); git(f.source, 'rm', '-rf', '.');
  const unrelated = commit(f.source, 'other'); git(f.source, 'push', f.remote, 'other');
  git(f.controller, 'fetch', f.remote, 'other');
  assert.throws(() => validateSource({ ...options(f), sha: unrelated }), /unreachable-sha/);
  assert.throws(() => validateSource({ ...options(f), dispatchSha: unrelated }), /untrusted-workflow-sha/);
  const blob = git(f.source, 'rev-parse', 'HEAD:other');
  assert.throws(() => validateSource({ ...options(f), sha: blob }), /unreachable-sha/);
  git(f.source, 'tag', 'v2'); git(f.source, 'push', f.remote, 'v2');
  assert.equal(validateSource({ ...options(f), sha: unrelated }), unrelated);
  git(f.source, 'push', f.remote, ':refs/tags/v2');
  assert.throws(() => validateSource({ ...options(f), sha: unrelated }), /unreachable-sha/);
}]);
sourceRows.push(['rejects force-push ancestry race between advertised refs and fetch', {}, t => {
  const f = fixture(t);
  git(f.source, 'checkout', '--orphan', 'other'); git(f.source, 'rm', '-rf', '.');
  const other = commit(f.source, 'other'); git(f.source, 'push', f.remote, 'other');
  const env = wrapper(f.root, `if(args.includes('fetch')) execFileSync(real,['--git-dir',${JSON.stringify(f.remote)},'update-ref','refs/heads/main',${JSON.stringify(other)}]);`);
  assert.throws(() => validateSource({ ...options(f), env }), /source-refs-changed/);
}]);

test("source validation admits only immutable reachable revisions from trusted dispatch", async t => {
  await runRows(t, sourceRows)
})
