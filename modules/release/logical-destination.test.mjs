import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { release } from './produce.mjs';
import { publicationScan, validatePublicationDestination } from './publication-scan.mjs';

const root = resolve(import.meta.dirname, '../..');
const project = 'author/logical-product';
const publicSlug = 'publisher/public-product';
const repository = 'https://github.com/' + publicSlug;
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t, sourceRepository = publicSlug, ghResponse = 'missing') {
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'logical-destination-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repo = resolve(temporary, 'source'); mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  const write = (name, value) => writeFileSync(resolve(repo, name), JSON.stringify(value));
  const recipe = { schemaVersion: 1, id: project, identityKind: 'project',
    toolchain: { id: 'runeditrun/edition-authoring', version: '1.1.0' }, parent: null,
    components: [{ id: project, role: 'edition', source: { kind: 'local', paths: ['README.md'] } }] };
  write('edition.json', recipe);
  write('rer-project.json', { schema: 1, projectId: project, sourceRepository });
  write('seed.json', { id: 'fixture', version: '1.2.3' });
  write('package.json', { version: '1.2.3', scripts: { verify: 'node --test' } });
  write('RELEASE.json', { version: '1.2.3' });
  writeFileSync(resolve(repo, 'README.md'), 'Synthetic destination fixture.\n');
  writeFileSync(resolve(repo, 'LICENSE'), readFileSync(resolve(root, 'LICENSE')));
  const commit = () => { git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture', '--allow-empty'); return git(repo, 'rev-parse', 'HEAD'); };
  git(repo, 'add', '.');
  execFileSync(process.execPath, [resolve(root, 'edition-authoring/cli.mjs'), 'lock'], { cwd: repo, stdio: 'pipe' });
  const selected = commit();
  const commands = resolve(temporary, 'commands'); mkdirSync(commands);
  const marker = resolve(temporary, 'install-started');
  const providerResponses = {
    missing: `process.stdout.write(${JSON.stringify('HTTP/2.0 404 Not Found\n\n' + JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository', status: '404' }) + '\n')}); process.exit(1);`,
    empty: "process.stdout.write('HTTP/2.0 404 Not Found\\n\\n{}\\n'); process.exit(1);",
  };
  // Test-only provider and installer sentinels. No dependency installation occurs.
  for (const [name, body] of Object.entries({
    gh: providerResponses[ghResponse],
    pnpm: `import('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1); });`,
  })) {
    const path = resolve(commands, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`); chmodSync(path, 0o755);
  }
  const prior = process.env.PATH;
  process.env.PATH = commands + ':' + prior;
  t.after(() => { process.env.PATH = prior; });
  return { repo, recipe, write, commit, selected, marker,
    options: { repo, project, repository, output: resolve(temporary, 'output'), tag: true } };
}

test('empty GitHub 404 remains incomplete and blocks producer export and tag', async t => {
  const f = fixture(t, publicSlug, 'empty');
  f.write('seed.json', { id: 'fixture', version: '1.2.3', name: 'Fixture', category: 'test',
    description: 'Synthetic destination fixture.', maturity: 'experimental' });
  writeFileSync(resolve(f.repo, 'CONTRACT.md'), '# Fixture\n\n- **TEST-001 — Exact bytes.** Export the verified committed bytes.\n');
  writeFileSync(resolve(f.repo, 'AGENTS.md'), '# Fixture\n');
  const selected = f.commit();
  const report = publicationScan(f.repo, selected, undefined, project, repository);
  assert.equal(report.status, 'INCOMPLETE');
  assert.ok(report.findings.some(item => item.rule === 'scan.github-incomplete'));
  assert.deepEqual(report.info, []);
  const receipt = await release({ ...f.options, ref: selected });
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.gates.publishCheck.status, 'INCOMPLETE');
  const persisted = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.ok(persisted.findings.some(item => item.rule === 'scan.github-incomplete'));
  assert.deepEqual(persisted.info, []);
  assert.equal(existsSync(f.marker), true);
  assert.equal(receipt.publicExport, null);
  assert.equal(receipt.tag.created, false);
  assert.equal(existsSync(resolve(f.options.output, 'public-source.tar')), false);
  assert.equal(existsSync(resolve(f.options.output, 'public-git')), false);
  assert.equal(git(f.repo, 'tag', '--list'), '');
});

for (const source of [publicSlug, repository]) {
  test(`producer validator and real publication scan accept a separate logical identity with ${source.startsWith('https:') ? 'URL' : 'bare'} source`, t => {
    const f = fixture(t, source);
    assert.doesNotThrow(() => validatePublicationDestination({ repo: f.repo, commit: f.selected }, project, repository));
    const report = publicationScan(f.repo, f.selected, undefined, project, repository);
    assert.equal(report.status, 'PASS', JSON.stringify(report));
    assert.ok(report.info.some(item => item.rule === 'pending-public-destination' && item.path === 'rer-project.json'));
    assert.deepEqual(report.findings, []);
    assert.equal(existsSync(f.marker), false);
    assert.equal(existsSync(f.options.output), false);
    assert.equal(git(f.repo, 'tag', '--list'), '');
  });
}

for (const scenario of ['cli-logical', 'cli-destination', 'project-id', 'project-schema', 'source-destination', 'source-bare-dotgit',
  'custody-conflict', 'unknown-opt-in', 'recipe-schema', 'lock-identity', 'lock-hash', 'lock-toolchain']) {
  test(`producer rejects logical ${scenario} before install, output or tag`, async t => {
    const f = fixture(t);
    const options = { ...f.options };
    const projectDocument = { schema: 1, projectId: project, sourceRepository: publicSlug };
    if (scenario === 'cli-logical') options.project = publicSlug;
    if (scenario === 'cli-destination') options.repository = 'https://github.com/' + project;
    if (scenario === 'project-id') projectDocument.projectId = publicSlug;
    if (scenario === 'project-schema') projectDocument.schema = 2;
    if (scenario === 'source-destination') projectDocument.sourceRepository = project;
    if (scenario === 'source-bare-dotgit') projectDocument.sourceRepository += '.git';
    if (scenario === 'custody-conflict') f.recipe.custody = { repository: 'https://github.com/' + project };
    if (scenario === 'unknown-opt-in') f.recipe.identityKind = 'repository';
    if (scenario === 'recipe-schema') f.recipe.schemaVersion = 2;
    f.write('edition.json', f.recipe); f.write('rer-project.json', projectDocument);
    if (scenario.startsWith('lock-')) {
      const lock = JSON.parse(readFileSync(resolve(f.repo, 'sources.lock.json')));
      if (scenario === 'lock-identity') lock.edition = publicSlug;
      if (scenario === 'lock-hash') lock.manifest = '0'.repeat(64);
      if (scenario === 'lock-toolchain') lock.toolchain.version = '1.0.0';
      f.write('sources.lock.json', lock);
    }
    const invalid = f.commit();
    // A later valid committed checkout cannot override the selected invalid tree.
    git(f.repo, 'checkout', '--detach', f.selected);
    for (const cleanHistory of [false, true]) {
      await assert.rejects(release({ ...options, ref: invalid, cleanHistory }), /Publication destination must agree/);
      assert.equal(existsSync(f.marker), false);
      assert.equal(existsSync(f.options.output), false);
      assert.equal(git(f.repo, 'tag', '--list'), '');
    }
  });
}
