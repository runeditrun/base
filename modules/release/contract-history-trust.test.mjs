import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { source, repository } from '../../cli/fixtures/release-github.mjs';

process.env.COREPACK_ENABLE_NETWORK = '0';
process.env.npm_config_offline = 'true';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const legacy = '# Historical contract\n\n## What it does\n\n- **TEST-001 — Exact bytes.** Export the verified committed bytes.\n';

function version(f, value) {
  for (const path of ['seed.json', 'package.json', 'RELEASE.json']) {
    const file = join(f.repo, path);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), version: value }));
  }
}

function history(f) {
  version(f, '1.2.2');
  writeFileSync(join(f.repo, 'CONTRACT.md'), legacy);
  const previous = f.commit();
  version(f, '1.2.3');
  return { previous, commit: f.commit() };
}

function invoke(f, commit, dryRun = false) {
  return f.invoke([], ['--ref', commit, '--tag', 'v1.2.3'], {
    [`repos/${repository}/actions/workflows/42/runs?head_sha=${commit}&per_page=100`]: [
      { workflow_runs: [{ ...f.run, head_sha: commit }] },
    ],
  }, { dryRun, validationError: true });
}

function refused({ result, receipt, output }) {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /CONTRACT\.md/);
  assert.equal(receipt, null);
  assert.equal(existsSync(output), false, 'Invalid contracts must fail before artifacts or installation');
}

test('I01 exported release refuses an unpublished lightweight predecessor created after the source', async t => {
  const f = await source(t, { portable: true });
  const { previous, commit } = history(f);
  refused(invoke(f, commit));
  git(f.repo, 'tag', 'v1.2.2', previous);
  assert.equal(git(f.remote, 'tag', '--list', 'v1.2.2'), '');
  assert.equal(git(f.repo, 'cat-file', '-t', 'v1.2.2'), 'commit');
  refused(invoke(f, commit));
  assert.equal(git(f.repo, 'tag', '--list', 'v1.2.3'), '');
});

test('I02 omission, movement and restoration of local predecessors never manufacture PASS', async t => {
  const f = await source(t);
  const { previous, commit } = history(f);
  const attempts = [invoke(f, commit, true)];
  git(f.repo, 'tag', '-a', 'v1.2.2', previous, '-m', 'v1.2.2');
  attempts.push(invoke(f, commit, true));
  git(f.repo, 'tag', '-f', 'v1.2.2', f.sha);
  attempts.push(invoke(f, commit, true));
  git(f.repo, 'tag', '-f', 'v1.2.2', previous);
  attempts.push(invoke(f, commit, true));
  for (const attempt of attempts) refused(attempt);
});

test('I03 an explicit earlier source ref cannot inherit unrecorded PASS from identical historical bytes', async t => {
  const f = await source(t);
  const { previous, commit } = history(f);
  git(f.repo, 'tag', 'v1.2.2', previous);
  writeFileSync(join(f.repo, 'CONTRACT.md'), legacy + '\nDifferent HEAD bytes.\n');
  const head = f.commit();
  refused(invoke(f, commit));
  refused(invoke(f, head));
});

test('I07 release applies the current contract guard even with a coherent local predecessor', async t => {
  const f = await source(t);
  const { previous, commit } = history(f);
  git(f.repo, 'tag', '-a', 'v1.2.2', previous, '-m', 'v1.2.2');
  refused(invoke(f, commit, true));
});
