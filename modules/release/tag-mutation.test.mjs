import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { source, repository } from '../../cli/fixtures/release-github.mjs';

const tagRef = 'refs/tags/v1.2.3';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function publish(f, commit = f.sha) {
  git(f.repo, '-c', 'tag.gpgSign=false', 'tag', '-a', '--cleanup=verbatim', 'v1.2.3', commit, '-m', 'v1.2.3\n');
  const object = git(f.repo, 'rev-parse', tagRef);
  git(f.repo, 'push', f.remote, tagRef);
  return object;
}

function release(f, commit, object) {
  return f.invoke([], ['--ref', commit, '--tag', 'v1.2.3'], {
    [`repos/${repository}/actions/workflows/42/runs?head_sha=${commit}&per_page=100`]: [{ workflow_runs: [{ ...f.run, head_sha: commit }] }],
    [`repos/${repository}/git/ref/tags/v1.2.3`]: { object: { type: 'tag', sha: object } },
    [`repos/${repository}/git/tags/${object}`]: { object: { type: 'commit', sha: commit } },
  }, { dryRun: false, validationError: true });
}

function build(f, command) {
  const path = join(f.repo, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.scripts.build = command;
  writeFileSync(path, JSON.stringify(pkg));
  return f.commit();
}

function refused(t, result, reason) {
  assert.equal(result.result.status, 2, result.result.stderr + result.result.stdout);
  assert.equal(result.receipt, null);
  assert.match(result.result.stderr, reason);
  assert.equal(existsSync(result.output), false, 'failed release removes incomplete artifacts');
  t.diagnostic(result.result.stderr.trim());
}

test('A05 remote tag replacement during build is refused', async t => {
  const f = await source(t);
  f.env.ADOPTION_REMOTE = f.remote;
  f.env.ADOPTION_REPLACEMENT = f.sha;
  const commit = build(f, 'git --git-dir="$ADOPTION_REMOTE" update-ref refs/tags/v1.2.3 "$ADOPTION_REPLACEMENT"');
  const object = publish(f, commit);
  refused(t, release(f, commit, object), /Remote release tag changed during release/);
  assert.equal(git(f.repo, 'rev-parse', tagRef), object);
  assert.equal(git(f.remote, 'rev-parse', tagRef), f.sha);
});

test('A08 remote tag replacement between advertisement and fetch is refused', async t => {
  const f = await source(t), object = publish(f);
  const transport = join(f.temporary, 'commands/git');
  const original = readFileSync(transport, 'utf8');
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const move = `if (args.includes('ls-remote') && args.includes(${JSON.stringify(tagRef)})) cp.execFileSync(${JSON.stringify(actualGit)}, ['-C', ${JSON.stringify(f.remote)}, 'update-ref', ${JSON.stringify(tagRef)}, ${JSON.stringify(f.sha)}]);\n`;
  writeFileSync(transport, original.replace('process.exitCode = result.status ?? 1;', move + 'process.exitCode = result.status ?? 1;'));
  refused(t, release(f, f.sha, object), /changed during inspection/);
  assert.equal(git(f.repo, 'rev-parse', tagRef), object);
  assert.equal(git(f.remote, 'rev-parse', tagRef), f.sha);
});

test('A09 local tag replacement during build is refused', async t => {
  const f = await source(t);
  f.env.ADOPTION_SOURCE = f.repo;
  f.env.ADOPTION_REPLACEMENT = f.sha;
  const commit = build(f, 'git -C "$ADOPTION_SOURCE" update-ref refs/tags/v1.2.3 "$ADOPTION_REPLACEMENT"');
  const object = publish(f, commit);
  refused(t, release(f, commit, object), /Local release tag changed during release/);
  assert.equal(git(f.repo, 'rev-parse', tagRef), f.sha);
  assert.equal(git(f.remote, 'rev-parse', tagRef), object);
});

test('A09 original local tag deletion during build is refused', async t => {
  const f = await source(t);
  f.env.ADOPTION_SOURCE = f.repo;
  const commit = build(f, 'git -C "$ADOPTION_SOURCE" update-ref -d refs/tags/v1.2.3');
  const object = publish(f, commit);
  refused(t, release(f, commit, object), /Local release tag changed during release/);
  assert.equal(git(f.repo, 'tag', '--list', 'v1.2.3'), '');
  assert.equal(git(f.remote, 'rev-parse', tagRef), object);
});

for (const [name, target] of [['different commit', 'HEAD^'], ['same commit, different annotation', 'HEAD']]) {
  test(`A10 staged tag replacement during build is refused: ${name}`, async t => {
    const f = await source(t);
    const commit = build(f, `git -c user.name=Fixture -c user.email=fixture@example.invalid -c tag.gpgSign=false tag -a v1.2.3 ${target} -m "Different annotation" && git update-ref refs/rer-release/adopted-tag refs/tags/v1.2.3`);
    const object = publish(f, commit);
    git(f.repo, 'tag', '-d', 'v1.2.3');
    refused(t, release(f, commit, object), /Staged release tag changed during release/);
    assert.equal(git(f.repo, 'tag', '--list', 'v1.2.3'), '', 'refusal must precede source tag creation');
    assert.equal(git(f.remote, 'rev-parse', tagRef), object);
  });
}

test('A10 staged tag deletion during build is refused before source tag creation', async t => {
  const f = await source(t);
  const commit = build(f, 'git update-ref -d refs/rer-release/adopted-tag');
  const object = publish(f, commit);
  git(f.repo, 'tag', '-d', 'v1.2.3');
  refused(t, release(f, commit, object), /Staged release tag changed during release/);
  assert.equal(git(f.repo, 'tag', '--list', 'v1.2.3'), '');
  assert.equal(git(f.remote, 'rev-parse', tagRef), object);
});
