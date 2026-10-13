import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { release } from './produce.mjs';
import { fixture } from './test-fixture.mjs';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();

test('explicit clean history exports and scans a parentless exact tree while private history remains intact', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'old-credential.txt'), 'ghp_' + randomBytes(20).toString('hex')); f.commit();
  rmSync(resolve(f.repo, 'old-credential.txt')); f.commit();
  const source = git(f.repo, 'rev-parse', 'HEAD');
  const receipt = await release({ ...f.options, cleanHistory: true });
  assert.equal(receipt.status, 'RELEASED');
  assert.equal(receipt.publicationHistory, 'parentless-export');
  const out = resolve(f.options.output, receipt.publicExport.gitPath);
  assert.equal(git(out, 'rev-list', '--all', '--count'), '1');
  assert.equal(git(out, 'rev-parse', 'HEAD^{tree}'), git(f.repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(git(out, 'rev-parse', 'v1.2.3^{commit}'), receipt.publicExport.commit);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3^{commit}'), source);
  assert.equal(git(f.repo, 'rev-list', '--all', '--count'), '3');
  assert.equal(git(out, 'remote'), '');
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.equal(report.status, 'PASS'); assert.equal(report.complete, true);
  assert.equal(report.history.commits, 1); assert.equal(report.source.commit, receipt.publicExport.commit);
  const manifest = JSON.parse(readFileSync(resolve(f.options.output, receipt.siteRelease.path)));
  assert.equal(manifest.provenance.revision, receipt.publicExport.commit);
  assert.equal(manifest.listing.repository, f.options.repository);
});

test('clean history refuses a current stored credential and exposes no export or tag', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'credential.txt'), 'ghp_' + randomBytes(20).toString('hex')); f.commit();
  const receipt = await release({ ...f.options, cleanHistory: true });
  assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.gates.publishCheck.status, 'FAIL');
  assert.equal(receipt.publicExport, null); assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.equal(existsSync(resolve(f.options.output, 'public-git')), false);
});

test('clean history environment matching cannot be reviewed away', async t => {
  const f = fixture(t);
  const value = 'synthetic-environment-value-123456789';
  writeFileSync(resolve(f.temporary, 'secrets.env'), `SYNTHETIC_KEY=${value}\n`);
  writeFileSync(resolve(f.repo, 'example.mjs'), `export const token = '${value}';\n`); f.commit();
  mkdirSync(resolve(f.repo, '.publish-check'));
  writeFileSync(resolve(f.repo, '.publish-check/reviewed.json'), JSON.stringify({ schemaVersion: 1, findings: [{ rule: 'secret.assignment', path: 'example.mjs', blob: git(f.repo, 'rev-parse', 'HEAD:example.mjs'), reason: 'Synthetic test credential', reviewer: 'Fixture', date: '2026-01-01' }] })); f.commit();
  const receipt = await release({ ...f.options, cleanHistory: true, envFile: resolve(f.temporary, 'secrets.env') });
  assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.gates.publishCheck.status, 'FAIL');
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.equal(report.guarantees.environmentChecked, true);
  assert.ok(report.findings.some(f => f.rule === 'secret.env-match'));
  assert.equal(receipt.publicExport, null); assert.equal(git(f.repo, 'tag', '--list'), '');
});


test('CLI accepts only the committed explicit tag version and passes clean-history/environment options', t => {
  const f = fixture(t);
  const cli = resolve(import.meta.dirname, '../../bin/rer.mjs');
  writeFileSync(resolve(f.temporary, 'secrets.env'), 'SYNTHETIC_KEY=fixture-value\n');
  const args = [cli, 'release', '--repo', f.repo, '--project', 'octocat/Hello-World', '--repository', 'https://github.com/octocat/Hello-World', '--output', f.options.output, '--clean-history', '--env-file', resolve(f.temporary, 'secrets.env')];
  const wrong = spawnSync(process.execPath, [...args, '--tag', 'v9.9.9'], { encoding: 'utf8' });
  assert.equal(wrong.status, 2); assert.equal(existsSync(f.options.output), false);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  const result = spawnSync(process.execPath, [...args, '--tag', 'v1.2.3'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'RELEASED'); assert.equal(receipt.publicationHistory, 'parentless-export');
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.equal(report.guarantees.environmentChecked, true);
});
