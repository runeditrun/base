import { caseRow, caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { source } from '../../cli/fixtures/release-github.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('rer release hydrates missing selected source and destination blobs before reading metadata', async t => {
  await caseRows(t, [['independent checks', async t => {
  const f = await source(t, { localPass: true, declaration: {} });
  const initial = git(f.repo, 'rev-parse', f.sha + '^');
  git(f.remote, 'update-ref', 'refs/heads/edition', f.sha);
  git(f.remote, 'update-ref', 'refs/heads/main', initial);
  git(f.remote, 'config', 'uploadpack.allowFilter', 'true');
  git(f.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const clone = join(f.temporary, 'partial');
  git(f.temporary, 'clone', '-q', '--single-branch', '--branch', 'main', '--filter=blob:none', pathToFileURL(f.remote).href, clone);
  git(clone, 'fetch', '-q', '--no-tags', '--filter=blob:none', 'origin', f.sha);
  const missing = git(clone, 'rev-list', '--objects', '--missing=print', f.sha).split('\n');
  let rowAt22 = 0;
  for (const path of ['edition.json', 'rer-project.json', 'package.json']) {
    await caseRow(t, 'table at line 22 row ' + rowAt22++, async () => {

    assert.ok(missing.includes('?' + git(f.repo, 'rev-parse', `${f.sha}:${path}`)), path);
      });
  }
  await caseRow(t, 'following assertion at line 25', async () => { assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false'); });
  const { result, receipt, output } = f.invoke([], ['--repo', clone, '--local-verify', '--tag'], {}, { dryRun: false });
  await caseRow(t, 'following assertion at line 27', async () => { assert.equal(result.status, 0, result.stderr + result.stdout); });
  await caseRow(t, 'following assertion at line 28', async () => { assert.equal(receipt.status, 'RELEASED'); });
  await caseRow(t, 'following assertion at line 29', async () => { assert.equal(receipt.source.commit, f.sha); });
  await caseRow(t, 'following assertion at line 30', async () => { assert.equal(receipt.gates.verify.status, 'PASS'); });
  await caseRow(t, 'following assertion at line 31', async () => { assert.equal(receipt.gates.publishCheck.status, 'PASS'); });
  await caseRow(t, 'following assertion at line 32', async () => { assert.equal(JSON.parse(readFileSync(join(output, 'release-receipt.json'))).status, 'RELEASED'); });
  await caseRow(t, 'following assertion at line 33', async () => { assert.equal(git(clone, 'rev-parse', 'v1.2.3^{commit}'), f.sha); });
  }]]);
});
