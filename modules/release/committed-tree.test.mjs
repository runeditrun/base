import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { release } from './produce.mjs';
import { fixture } from './test-fixture.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const report = f => JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
const credential = () => 'ghp_' + randomBytes(20).toString('hex');

test('release ignores caller credentials and build output that are absent from the committed tree', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, '.gitignore'), '.dev.vars\ndist/\n');
  const commit = f.commit();
  const local = { '.dev.vars': `GITHUB_TOKEN=${credential()}\n`, 'dist/bundle.js': `const token = '${credential()}';\n` };
  mkdirSync(resolve(f.repo, 'dist'));
  for (const [path, bytes] of Object.entries(local)) writeFileSync(resolve(f.repo, path), bytes);
  assert.equal(git(f.repo, 'status', '--porcelain', '--untracked-files=all'), '');

  const receipt = await release(f.options).catch(error => {
    t.diagnostic(git(f.repo, 'status', '--porcelain', '--untracked-files=all'));
    throw error;
  });
  assert.equal(receipt.status, 'RELEASED', JSON.stringify(report(f).findings.map(({ path, rule, scope }) => ({ path, rule, scope }))));
  assert.equal(receipt.gates.publishCheck.status, 'PASS');
  assert.equal(receipt.gates.publishCheck.findings, 0);
  assert.deepEqual(report(f).findings, []);
  assert.equal(report(f).source.commit, commit);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3^{commit}'), commit);
  const paths = execFileSync('tar', ['-tf', resolve(f.options.output, receipt.publicExport.path)], { encoding: 'utf8' }).split('\n').map(path => path.replace(/^\.\//, ''));
  for (const [path, bytes] of Object.entries(local)) {
    assert.equal(paths.includes(path), false);
    assert.equal(readFileSync(resolve(f.repo, path), 'utf8'), bytes);
  }
});

test('release still blocks a credential committed at the selected source ref even when HEAD removed it', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'credential.txt'), credential());
  const commit = f.commit();
  rmSync(resolve(f.repo, 'credential.txt'));
  f.commit();

  const receipt = await release({ ...f.options, ref: commit });
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.gates.verify.status, 'PASS');
  assert.equal(receipt.gates.publishCheck.status, 'FAIL');
  assert.equal(report(f).source.commit, commit);
  assert.ok(report(f).findings.some(hit => hit.path === 'credential.txt' && hit.commit === commit && hit.rule.startsWith('secret.')));
  assert.equal(receipt.publicExport, null);
  assert.equal(git(f.repo, 'tag', '--list'), '');
});
