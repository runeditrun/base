import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { publicFixture, git } from './public-child-fixture.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';

test('rer release retains exact public source and annotations but refuses unpublished email', async t => {
  const nativeGit = execFileSync('which', ['git']).toString().trim();
  const f = publicFixture(t), env = await isolatedQueue(t);
  // Store the real public URL: the transport double maps command arguments.
  const origin = url => execFileSync(nativeGit, ['-C', f.repo, 'config', 'remote.origin.url', url]);
  origin(f.options.repository);
  git(f.bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const publishedEmail = ['published-person', 'release-company.com'].join('@');
  git(f.repo, 'commit', '--allow-empty', '-qm', `Public contact: ${publishedEmail}`);
  git(f.repo, 'tag', '-a', 'v1.2.2', '-m', `Public contact: ${publishedEmail}`);
  git(f.repo, 'push', f.bare, 'HEAD:refs/heads/main', 'refs/tags/v1.2.2');
  const source = git(f.repo, 'rev-parse', 'HEAD');
  const invoke = (name, flags = [], repository = f.options.repository) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../../bin/rer.mjs'),
    'release', '--repo', f.repo, '--ref', source, '--project', f.options.project, '--repository', repository,
    '--output', resolve(f.temporary, name), ...flags], { env, encoding: 'utf8', timeout: 120000 });
  const published = invoke('published', ['--tag'], 'https://github.com/octocat/Spoon-Knife');
  assert.equal(published.status, 0, published.stderr + published.stdout);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3^{commit}'), source);
  assert.equal(JSON.parse(published.stdout).source.commit, source);
  const report = JSON.parse(readFileSync(resolve(f.temporary, 'published/publish-check.json')));
  assert.equal(report.source.commit, source);
  assert.ok(report.preExisting.some(hit => hit.rule === 'hygiene.email' && hit.path === '@commit-message'));
  assert.ok(report.preExisting.some(hit => hit.rule === 'hygiene.email' && hit.path === '@tag-message'));
  assert.equal(report.annotationInspection.status, 'PASS');
  assert.equal(report.annotationInspection.publicBase.commit, source);
  const tag = git(f.repo, 'rev-parse', 'v1.2.3');
  origin('https://github.com/octocat/Spoon-Knife');
  const explicit = invoke('explicit', ['--public-base', f.options.repository + '#main', '--tag', '--dry-run']);
  assert.equal(explicit.status, 0, explicit.stderr + explicit.stdout);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3'), tag);
  origin(f.options.repository);
  git(f.repo, 'commit', '--allow-empty', '-qm', `Unpublished contact: ${['private-person', 'private-company.com'].join('@')}`);
  const unpublished = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../bin/rer.mjs'),
    'release', '--repo', f.repo, '--project', f.options.project, '--repository', f.options.repository,
    '--output', resolve(f.temporary, 'unpublished')],
  { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(unpublished.status, 1, unpublished.stderr + unpublished.stdout);
  const blocked = JSON.parse(readFileSync(resolve(f.temporary, 'unpublished/publish-check.json')));
  assert.ok(blocked.findings.some(hit => hit.rule === 'hygiene.email' && hit.path === '@commit-message' && hit.scope === 'release-tree'));
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3'), tag);
});
