import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { release } from './produce.mjs';
import { publicationScan } from './publication-scan.mjs';
import { fixture } from './test-fixture.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = path => JSON.parse(readFileSync(path));
const cli = resolve(import.meta.dirname, '../../bin/rer.mjs');

function declare(f) {
  writeFileSync(resolve(f.repo, 'edition.json'), JSON.stringify({ id: f.options.project, custody: { repository: f.options.repository + '.git' } }));
  writeFileSync(resolve(f.repo, 'rer-project.json'), JSON.stringify({ projectId: f.options.project, sourceRepository: f.options.repository }));
  return f.commit();
}

function api(t, f, state = 'missing') {
  const commands = resolve(f.temporary, 'commands'); mkdirSync(commands);
  const executable = resolve(commands, 'gh');
  const body = state === 'missing' ? { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository', status: '404' } : { private: state === 'private' };
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('HTTP/2.0 ${state === 'missing' ? 404 : 200} Result\\n\\n${JSON.stringify(body)}\\n');\nprocess.stderr.write('private-gh-diagnostic');\nprocess.exit(${state === 'missing' ? 1 : 0});\n`);
  chmodSync(executable, 0o755);
  const old = process.env.PATH;
  process.env.PATH = commands + ':' + old;
  t.after(() => { process.env.PATH = old; });
  return commands;
}

for (const cleanHistory of [false, true]) {
  for (const dryRun of [false, true]) {
    test(`real CLI forwards the agreed pending destination through ${cleanHistory ? 'clean export' : 'source and staged annotation'} scans, dryRun=${dryRun}`, t => {
      const f = fixture(t);
      api(t, f);
      declare(f);
      const notes = `Public source: ${f.options.repository}`;
      writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: notes }));
      const source = f.commit();
      const result = spawnSync(process.execPath, [cli, 'release', '--repo', f.repo, '--project', f.options.project,
        '--repository', f.options.repository + '.git', '--output', f.options.output, '--tag', 'v1.2.3', '--local-verify',
        ...(cleanHistory ? ['--clean-history'] : []), ...(dryRun ? ['--dry-run'] : [])], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.status, dryRun ? 'DRY_RUN' : 'RELEASED');
      assert.equal(receipt.source.commit, source);
      assert.equal(git(f.repo, 'tag', '--list'), dryRun ? '' : 'v1.2.3');
      const report = read(resolve(f.options.output, 'publish-check.json'));
      assert.equal(report.status, 'PASS');
      assert.deepEqual(report.findings, []);
      assert.ok(report.info.some(item => item.rule === 'pending-public-destination' && item.severity === 'INFO'));
      const annotation = cleanHistory ? report : report.annotationInspection;
      assert.ok(annotation.info.some(item => item.rule === 'pending-public-destination' && item.path === '@tag-message'));
      assert.equal(annotation.history.tagMessages, 1);
      assert.ok(!JSON.stringify(report).includes('private-gh-diagnostic'));
      if (cleanHistory) {
        const exported = resolve(f.options.output, 'public-git');
        assert.equal(git(exported, 'rev-list', '--all', '--count'), '1');
        assert.equal(git(exported, 'rev-parse', 'HEAD^{tree}'), receipt.source.tree);
        for (const object of ['HEAD', 'v1.2.3']) {
          const text = git(exported, 'cat-file', '-p', object);
          assert.ok(!text.includes(source));
          assert.ok(text.endsWith(`v1.2.3\n\n${notes}`));
        }
        assert.notEqual(receipt.publicExport.commit, source);
        const manifest = read(resolve(f.options.output, receipt.siteRelease.path));
        assert.equal(manifest.provenance.revision, receipt.publicExport.commit);
        assert.ok(!JSON.stringify(manifest).includes(source));
      }
    });
  }
}

test('untagged preview scans pending declarations through the real producer', async t => {
  const f = fixture(t); api(t, f); declare(f);
  writeFileSync(resolve(f.repo, 'edition.json'), JSON.stringify({ id: f.options.project })); f.commit();
  const receipt = await release({ ...f.options, tag: false });
  assert.equal(receipt.status, 'DRY_RUN');
  assert.equal(receipt.publicExport, null);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.ok(read(resolve(f.options.output, 'publish-check.json')).info.some(item => item.rule === 'pending-public-destination'));
});

for (const scenario of ['different-missing', 'private-target', 'legacy-missing', 'unsafe-public-notes']) {
  test(`producer blocks ${scenario} despite a declared pending destination`, async t => {
    const f = fixture(t); api(t, f, scenario === 'private-target' ? 'private' : 'missing');
    if (scenario !== 'legacy-missing') declare(f);
    writeFileSync(resolve(f.repo, 'README.md'), scenario === 'different-missing'
      ? f.options.repository + '\nhttps://github.com/octocat/Spoon-Knife' : f.options.repository);
    if (scenario === 'unsafe-public-notes') writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: `${f.options.repository}\nInternal ${['', 'home', 'personal', 'workspace'].join('/')}` }));
    f.commit();
    const receipt = await release({ ...f.options, cleanHistory: true });
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(receipt.publicExport, null);
    assert.equal(git(f.repo, 'tag', '--list'), '');
    assert.equal(existsSync(resolve(f.options.output, 'public-git')), false);
    const report = read(resolve(f.options.output, 'publish-check.json'));
    const rule = scenario === 'private-target' ? 'hygiene.github-private'
      : scenario === 'unsafe-public-notes' ? 'hygiene.local-path' : 'hygiene.github-missing';
    assert.ok(report.findings.some(item => item.rule === rule));
    if (scenario === 'unsafe-public-notes') {
      for (const path of ['RELEASE.json', '@commit-message', '@tag-message']) {
        assert.ok(report.findings.some(item => item.path === path && item.rule === rule));
        assert.ok(report.info.some(item => item.path === path && item.rule === 'pending-public-destination'));
      }
    }
  });
}

test('producer rejects inconsistent or nonordinary committed destination inputs before install, verify, output or tag', async t => {
  const f = fixture(t); const commands = api(t, f);
  const marker = resolve(f.temporary, 'install-started');
  const pnpm = resolve(commands, 'pnpm');
  writeFileSync(pnpm, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1);\n`);
  chmodSync(pnpm, 0o755);
  for (const scenario of ['cli-project', 'cli-url', 'edition-id', 'edition-url', 'project-id', 'project-url', 'malformed', 'missing-identity', 'symlink', 'directory']) {
    declare(f);
    let options = { ...f.options, dryRun: true, cleanHistory: true };
    if (scenario === 'cli-project') options.project = 'octocat/Spoon-Knife';
    if (scenario === 'cli-url') options.repository = 'https://github.com/octocat/Spoon-Knife';
    if (scenario === 'edition-id') writeFileSync(resolve(f.repo, 'edition.json'), JSON.stringify({ id: 'octocat/Spoon-Knife', custody: { repository: f.options.repository } }));
    if (scenario === 'edition-url') writeFileSync(resolve(f.repo, 'edition.json'), JSON.stringify({ id: f.options.project, custody: { repository: 'https://github.com/octocat/Spoon-Knife' } }));
    if (scenario === 'project-id') writeFileSync(resolve(f.repo, 'rer-project.json'), JSON.stringify({ projectId: 'octocat/Spoon-Knife', sourceRepository: f.options.repository }));
    if (scenario === 'project-url') writeFileSync(resolve(f.repo, 'rer-project.json'), JSON.stringify({ projectId: f.options.project, sourceRepository: 'https://github.com/octocat/Spoon-Knife' }));
    if (scenario === 'malformed') writeFileSync(resolve(f.repo, 'edition.json'), '{');
    if (scenario === 'missing-identity') writeFileSync(resolve(f.repo, 'edition.json'), '{}');
    if (['symlink', 'directory'].includes(scenario)) rmSync(resolve(f.repo, 'edition.json'));
    if (scenario === 'symlink') symlinkSync('README.md', resolve(f.repo, 'edition.json'));
    if (scenario === 'directory') { mkdirSync(resolve(f.repo, 'edition.json')); writeFileSync(resolve(f.repo, 'edition.json/file'), '{}'); }
    f.commit();
    await assert.rejects(release(options), /Publication destination must agree/, scenario);
    assert.equal(existsSync(marker), false, scenario);
    assert.equal(existsSync(f.options.output), false, scenario);
    assert.equal(git(f.repo, 'tag', '--list'), '', scenario);
    if (['symlink', 'directory'].includes(scenario)) rmSync(resolve(f.repo, 'edition.json'), { recursive: true });
  }
});


test('publicationScan retains its three-argument strict API and fails partial explicit context', t => {
  const f = fixture(t); api(t, f); declare(f);
  const strict = publicationScan(f.repo, 'HEAD', undefined);
  assert.equal(strict.status, 'FAIL');
  assert.ok(strict.findings.some(item => item.rule === 'hygiene.github-missing'));
  assert.deepEqual(strict.info, []);
  const partial = publicationScan(f.repo, 'HEAD', undefined, f.options.project);
  assert.equal(partial.status, 'FAIL');
  assert.ok(partial.findings.some(item => item.rule === 'destination.invalid'));
  assert.deepEqual(partial.info, []);
});
