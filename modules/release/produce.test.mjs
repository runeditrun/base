import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { release } from './produce.mjs';
import { fixture } from './test-fixture.mjs';
const root = resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

test('successful producer verifies, tags the exact commit, exports bytes and pins site artifacts', async t => {
  const f = fixture(t);
  const receipt = await release(f.options);
  assert.equal(receipt.status, 'RELEASED', JSON.stringify(receipt));
  assert.equal(receipt.gates.verify.tests, 1);
  assert.equal(receipt.gates.verify.passed, 1);
  assert.equal(receipt.gates.publishCheck.status, 'PASS');
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3^{commit}'), f.sha);
  assert.equal(git(f.repo, 'cat-file', '-t', 'v1.2.3'), 'tag');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(receipt.tag.created, true); assert.equal(receipt.tag.pushed, false);
  const archive = resolve(f.options.output, receipt.publicExport.path);
  assert.equal(hash(readFileSync(archive)), receipt.publicExport.sha256);
  const unpacked = resolve(f.temporary, 'unpacked'); mkdirSync(unpacked);
  execFileSync('tar', ['-xf', archive, '-C', unpacked]);
  for (const [path, bytes] of Object.entries(f.files)) assert.deepEqual(readFileSync(resolve(unpacked, path)), Buffer.from(bytes));
  assert.equal(existsSync(resolve(unpacked, '.git')), false);
  const manifestPath = resolve(f.options.output, receipt.siteRelease.path);
  const manifest = JSON.parse(readFileSync(manifestPath));
  assert.equal(manifest.provenance.revision, f.sha);
  assert.equal(manifest.provenance.publication, 'local-release');
  assert.deepEqual(manifest.listing.clauses, [{ id: 'TEST-001', title: 'Exact bytes', text: 'Export the verified committed bytes.' }]);
  for (const artifact of manifest.artifacts) assert.equal(hash(readFileSync(resolve(manifestPath, '..', artifact.path))), artifact.sha256);
  const registry = JSON.parse(readFileSync(resolve(f.options.output, 'site/registry.json')));
  assert.equal(registry.releases[0].sha256, hash(readFileSync(manifestPath)));
  assert.equal(registry.releases[0].path, 'fixture/1.2.3/release.json');
});

test('clean dry run creates an export and preview, with no tag or source changes', async t => {
  const f = fixture(t);
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'DRY_RUN', JSON.stringify(receipt));
  assert.equal(receipt.tag.created, false);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.sha);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(JSON.parse(readFileSync(resolve(f.options.output, receipt.siteRelease.path))).provenance.publication, 'dry-run');
});

test('dry runs execute declared release verification after default verification and block its failure', async t => {
  for (const exit of [0, 7]) {
    const f = fixture(t);
    const pkg = JSON.parse(readFileSync(resolve(f.repo, 'package.json')));
    pkg.scripts.verify += ' && node -e "require(\'fs\').writeFileSync(\'default-complete\',\'yes\')"';
    pkg.scripts['verify:release'] = `node --test check.test.mjs && node -e "require('fs').accessSync('default-complete');process.exit(${exit})"`;
    writeFileSync(resolve(f.repo, 'package.json'), JSON.stringify(pkg));
    f.commit();
    const receipt = await release({ ...f.options, dryRun: true, tag: false });
    assert.equal(receipt.gates.verify.release.exitCode, exit);
    assert.equal(receipt.gates.verify.release.passed, 1);
    assert.equal(receipt.status, exit === 0 ? 'DRY_RUN' : 'BLOCKED');
    assert.equal(receipt.gates.verify.status, exit === 0 ? 'PASS' : 'FAIL');
    if (exit) assert.equal(receipt.gates.verify.reason, 'release-verification-failed');
    assert.equal(receipt.publicExport, null);
    assert.equal(git(f.repo, 'tag', '--list'), '');
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
  }
});

test('pnpm 8 seed install policy remains frozen and unchanged', async t => {
  const f = fixture(t, 'node --test check.test.mjs', 'pnpm@8.15.6');
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'DRY_RUN', JSON.stringify(receipt));
  assert.equal(receipt.gates.verify.tests, 1);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.deepEqual(readFileSync(resolve(f.repo, 'pnpm-lock.yaml')), f.files['pnpm-lock.yaml']);
});

test('verify failure blocks tagging and public export; dry run emits an explicitly blocked preview', async t => {
  const f = fixture(t, 'node -e "process.exit(7)"');
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.gates.verify.exitCode, 7);
  assert.equal(receipt.publicExport, null);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.equal(JSON.parse(readFileSync(resolve(f.options.output, receipt.siteRelease.path))).provenance.publication, 'blocked');
});

test('historical publication defect blocks a normal release despite clean verified HEAD', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'credential.txt'), 'ghp_' + randomBytes(20).toString('hex')); f.commit();
  rmSync(resolve(f.repo, 'credential.txt')); f.commit();
  const receipt = await release(f.options);
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.gates.verify.status, 'PASS');
  assert.equal(receipt.gates.publishCheck.status, 'FAIL');
  assert.equal(receipt.publicExport, null); assert.equal(receipt.siteRelease, null);
  assert.equal(existsSync(resolve(f.options.output, 'public-source.tar')), false);
  assert.equal(git(f.repo, 'tag', '--list'), '');
});

test('verification cannot mutate the source being certified', async t => {
  const f = fixture(t, 'node -e "require(\'fs\').appendFileSync(\'CONTRACT.md\',\'changed\')"');
  const receipt = await release(f.options);
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.gates.verify.reason, 'verify-changed-tracked-source');
  assert.equal(receipt.publicExport, null);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.equal(readFileSync(resolve(f.repo, 'CONTRACT.md'), 'utf8'), f.files['CONTRACT.md']);
});

test('export attributes cannot change or omit checked source bytes', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, '.gitattributes'), 'README.md export-ignore\nAGENTS.md export-subst\n');
  writeFileSync(resolve(f.repo, 'AGENTS.md'), '$Format:%H$\n'); f.commit();
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'DRY_RUN', JSON.stringify(receipt));
  const out = resolve(f.temporary, 'unpack'); mkdirSync(out);
  execFileSync('tar', ['-xf', resolve(f.options.output, receipt.publicExport.path), '-C', out]);
  assert.equal(readFileSync(resolve(out, 'AGENTS.md'), 'utf8'), '$Format:%H$\n');
  assert.equal(readFileSync(resolve(out, 'README.md'), 'utf8'), f.files['README.md']);
});

test('dirty sources, existing tags, inconsistent versions and output aliases are rejected before a release', async t => {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'untracked'), 'dirty');
  await assert.rejects(release(f.options), /clean source checkout/);
  rmSync(resolve(f.repo, 'untracked'));
  git(f.repo, 'tag', 'v1.2.3');
  await assert.rejects(release(f.options), /already exists/);
  git(f.repo, 'tag', '-d', 'v1.2.3');
  const alias = resolve(f.temporary, 'alias'); symlinkSync(f.repo, alias);
  await assert.rejects(release({ ...f.options, output: resolve(alias, 'new') }), /symlinks/);
  assert.equal(existsSync(resolve(f.repo, 'new')), false);
  writeFileSync(resolve(f.repo, 'RELEASE.json'), '{"version":"9.9.9"}'); f.commit();
  await assert.rejects(release(f.options), /versions must agree/);
});

test('rer release CLI invokes the producer and prints the redacted tail of a failing verify, never a credential', t => {
  const canary = 'ghp_' + randomBytes(20).toString('hex');
  const f = fixture(t, `node -e "console.log('GITHUB_TOKEN=${canary}');console.error('synthetic-failure-line');process.exit(3)"`);
  const result = spawnSync(process.execPath, [resolve(root, 'bin/rer.mjs'), 'release', '--repo', f.repo, '--project', 'octocat/Hello-World', '--repository', 'https://github.com/octocat/Hello-World', '--output', f.options.output, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'BLOCKED');
  assert.match(receipt.gates.verify.output, /synthetic-failure-line/);
  assert.equal((result.stdout + result.stderr + readFileSync(resolve(f.options.output, 'release-receipt.json'), 'utf8')).includes(canary), false);
});

test('rer release installs seed dependencies without the caller credentials; the seed verify keeps them', t => {
  const record = kind => `require('fs').writeFileSync(require('path').join(process.env.PROBE_RECORDS,'${kind}.json'),JSON.stringify(Object.keys(process.env)))`;
  const f = fixture(t, `node -e "${record('verify')}" && node --test check.test.mjs`);
  mkdirSync(resolve(f.repo, 'probe'));
  writeFileSync(resolve(f.repo, 'probe/package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { install: 'node record.cjs' } }));
  writeFileSync(resolve(f.repo, 'probe/record.cjs'), record('install') + ';\n');
  const pkg = JSON.parse(readFileSync(resolve(f.repo, 'package.json')));
  writeFileSync(resolve(f.repo, 'package.json'), JSON.stringify({ ...pkg, devDependencies: { probe: 'file:./probe' }, pnpm: { onlyBuiltDependencies: ['probe'] } }));
  execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: f.repo, stdio: ['ignore', 'pipe', 'pipe'] });
  f.commit();
  const records = resolve(f.temporary, 'records'); mkdirSync(records);
  const credentials = { CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token-0001', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', GITHUB_TOKEN: 'ghp_' + randomBytes(18).toString('hex'), FOO_SECRET: 'synthetic-secret-0001', PGPASSWORD: 'synthetic-password-0001' };
  const result = spawnSync(process.execPath, [resolve(root, 'bin/rer.mjs'), 'release', '--repo', f.repo, '--project', 'octocat/Hello-World', '--repository', 'https://github.com/octocat/Hello-World', '--output', f.options.output, '--dry-run'], { encoding: 'utf8', env: { ...process.env, ...credentials, PROBE_RECORDS: records } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const seen = kind => JSON.parse(readFileSync(resolve(records, `${kind}.json`), 'utf8'));
  for (const name of Object.keys(credentials)) {
    assert.ok(!seen('install').includes(name), `${name} never reaches a dependency install script`);
    assert.ok(seen('verify').includes(name), `the seed's verify receives ${name}`);
  }
});

test('bare release runs real gates and writes only a preview, including with an existing version tag', async t => {
  const f = fixture(t);
  git(f.repo, 'tag', 'v1.2.3');
  const before = git(f.repo, 'show-ref', '--tags');
  const receipt = await release({ ...f.options, tag: false });
  assert.equal(receipt.status, 'DRY_RUN');
  assert.equal(receipt.gates.verify.passed, 1);
  assert.equal(receipt.gates.publishCheck.status, 'PASS');
  assert.equal(receipt.publicExport, null);
  assert.equal(existsSync(resolve(f.options.output, 'public-source.tar')), false);
  assert.equal(receipt.tag.created, false);
  assert.equal(git(f.repo, 'show-ref', '--tags'), before);
  assert.equal(JSON.parse(readFileSync(resolve(f.options.output, receipt.siteRelease.path))).provenance.publication, 'dry-run');
});

test('CLI tags only with explicit --tag', t => {
  const f = fixture(t);
  const args = [resolve(root, 'bin/rer.mjs'), 'release', '--repo', f.repo, '--project', 'octocat/Hello-World', '--repository', 'https://github.com/octocat/Hello-World'];
  const preview = spawnSync(process.execPath, [...args, '--output', f.options.output], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  const receipt = JSON.parse(preview.stdout);
  assert.equal(receipt.gates.verify.passed, 1);
  assert.equal(receipt.gates.publishCheck.status, 'PASS');
  assert.equal(receipt.publicExport, null);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  const tagged = spawnSync(process.execPath, [...args, '--output', resolve(f.temporary, 'tagged'), '--tag'], { encoding: 'utf8' });
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.equal(JSON.parse(tagged.stdout).tag.created, true);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3^{commit}'), f.sha);
});
