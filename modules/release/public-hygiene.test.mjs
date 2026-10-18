import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { release } from './produce.mjs';
import { fixture } from './test-fixture.mjs';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('parentless public messages contain only the version and declared public notes, and final tag is scanned', async t => {
  const f = fixture(t);
  const notes = 'Improve invitation delivery and account recovery.';
  writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: notes }));
  const privateCommit = f.commit();
  const receipt = await release({ ...f.options, cleanHistory: true });
  assert.equal(receipt.status, 'RELEASED');
  const out = resolve(f.options.output, 'public-git');
  assert.equal(git(out, 'log', '-1', '--format=%B'), `v1.2.3\n\n${notes}`);
  assert.equal(git(out, 'for-each-ref', '--format=%(contents)', 'refs/tags/v1.2.3'), `v1.2.3\n\n${notes}`);
  assert.ok(!git(out, 'cat-file', '-p', 'HEAD').includes(privateCommit));
  assert.ok(!git(out, 'cat-file', '-p', 'v1.2.3').includes(privateCommit));
  assert.equal(receipt.source.commit, privateCommit);
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.equal(report.history.commitMessages, 1);
  assert.equal(report.history.tagMessages, 1);
  assert.equal(report.status, 'PASS');
});

test('producer blocks personal release notes in the actual export commit and final annotated tag', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: ['', 'home', 'private-person', 'workspace'].join('/') }));
  f.commit();
  const receipt = await release({ ...f.options, cleanHistory: true });
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.publicExport, null);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  for (const path of ['RELEASE.json', '@commit-message', '@tag-message']) {
    assert.ok(report.findings.some(f => f.path === path && f.rule === 'hygiene.local-path'), path);
  }
});

test('ordinary producer retains source scan and records inspection of its staged final annotation', async t => {
  // Verification leaves ignored build output holding a personal address, as a
  // bundled dependency can; it is not release source, so the annotation scan ignores it.
  const f = fixture(t, `node -e "require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/bundle.js','// contact person'+String.fromCharCode(64)+'gmail.com')" && node --test check.test.mjs`);
  writeFileSync(resolve(f.repo, '.gitignore'), 'dist/\n');
  f.sha = f.commit();
  const receipt = await release(f.options);
  assert.equal(receipt.status, 'RELEASED');
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.equal(report.source.commit, f.sha);
  assert.equal(report.annotationInspection.status, 'PASS');
  assert.equal(report.annotationInspection.history.tagMessages, 1);
  assert.equal(report.invocation.scans, 1);
  assert.equal(report.invocation.stagedAnnotation, true);
  assert.equal(git(f.repo, 'for-each-ref', '--format=%(contents)', 'refs/tags/v1.2.3'), 'v1.2.3');
});
