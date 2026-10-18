import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { release } from './produce.mjs';
import { fixture } from './test-fixture.mjs';

// The fixture has an empty dependency graph. Forbid package-manager acquisition
// and registry access, including in the producer's real frozen install.
process.env.COREPACK_ENABLE_NETWORK = '0';
process.env.npm_config_offline = 'true';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const legacy = [
  '# Existing contract', '', '## What it does', '',
  '- **TEST-001 — Exact bytes.** Export the verified committed bytes.',
  '  Preserve continuation text.', '',
  '**TEST-002 — Paragraph.** Keep paragraph text.', '',
  '### TEST-003 — Heading.', '', 'Keep heading text.', '',
  '## Future work', '', '- **TEST-004 — Future.** Not published.', '',
  '## Target clauses', '', '- **TEST-005 — Target.** Not published.', '',
  '## Push further', '', '### TEST-006 — Later.', '', 'Not published.', '',
  '## Status', '', '| Clause | Kind | Status |', '|---|---|---|',
  '| TEST-001 | published | done |', '| TEST-002 | published | done |',
  '| TEST-003 | published | done |', '| TEST-004 | target | missing |', '',
].join('\n');

function version(f, value) {
  for (const path of ['seed.json', 'package.json', 'RELEASE.json']) {
    const file = resolve(f.repo, path), data = JSON.parse(readFileSync(file));
    writeFileSync(file, JSON.stringify({ ...data, version: value }));
  }
}
function prior(t, old = '1.2.2', current = '1.2.3') {
  const f = fixture(t);
  version(f, old);
  writeFileSync(resolve(f.repo, 'CONTRACT.md'), legacy);
  const commit = f.commit();
  git(f.repo, 'tag', '-a', `v${old}`, '-m', `v${old}`);
  const blob = git(f.repo, 'rev-parse', `${commit}:CONTRACT.md`);
  version(f, current); f.commit();
  return { ...f, previous: { tag: `v${old}`, commit, blob } };
}
async function refused(f) {
  await assert.rejects(release({ ...f.options, dryRun: true }), /CONTRACT\.md/);
  assert.equal(existsSync(f.options.output), false);
}

test('unchanged legacy patch contract inherits judgment and publishes actual clauses', async t => {
  const f = prior(t);
  // Historical parser code is data only, including code from the chosen tag.
  git(f.repo, 'checkout', '--detach', f.previous.commit);
  mkdirSync(resolve(f.repo, 'foundation/runtime'), { recursive: true });
  writeFileSync(resolve(f.repo, 'foundation/runtime/seed-contract.mjs'), 'throw Error("historical code must never execute");\n');
  const historical = f.commit();
  git(f.repo, 'tag', '-f', '-a', f.previous.tag, '-m', f.previous.tag);
  version(f, '1.2.3'); f.commit(); f.previous.commit = historical;
  for (const cleanHistory of [false, true]) {
    const output = resolve(f.temporary, cleanHistory ? 'clean-release' : 'release');
    const receipt = await release({ ...f.options, output, dryRun: true, cleanHistory });
    assert.equal(receipt.status, 'DRY_RUN', JSON.stringify(receipt));
    const manifest = JSON.parse(readFileSync(resolve(output, receipt.siteRelease.path)));
    assert.deepEqual(manifest.provenance.contractJudgment, { status: 'PASS', mode: 'inherited', ...f.previous });
    assert.deepEqual(manifest.listing.clauses, [
      { id: 'TEST-001', title: 'Exact bytes', text: 'Export the verified committed bytes. Preserve continuation text.' },
      { id: 'TEST-002', title: 'Paragraph', text: 'Keep paragraph text.' },
      { id: 'TEST-003', title: 'Heading', text: 'Keep heading text.' },
    ]);
  }
});

test('unchanged patch uses highest available lower stable tag when patch numbers have gaps', async t => {
  const f = prior(t, '1.2.9', '1.2.11');
  // There need not be a preceding integer patch or any modern Status schema.
  const text = legacy.slice(0, legacy.indexOf('## Future work'));
  git(f.repo, 'checkout', '--detach', f.previous.commit);
  writeFileSync(resolve(f.repo, 'CONTRACT.md'), text);
  const commit = f.commit(); git(f.repo, 'tag', '-f', '-a', 'v1.2.9', '-m', 'v1.2.9');
  git(f.repo, 'tag', 'v1.2.8');
  version(f, '1.2.11'); f.commit();
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'DRY_RUN', JSON.stringify(receipt));
  const manifest = JSON.parse(readFileSync(resolve(f.options.output, receipt.siteRelease.path)));
  assert.equal(manifest.provenance.contractJudgment.tag, 'v1.2.9');
  assert.equal(manifest.provenance.contractJudgment.commit, commit);
  assert.deepEqual(manifest.listing.clauses.map(clause => clause.id), ['TEST-001', 'TEST-002', 'TEST-003']);
});

test('changed legacy patch contract requires current judgment', async t => {
  const f = prior(t);
  writeFileSync(resolve(f.repo, 'CONTRACT.md'), legacy + '\nChanged contract.\n'); f.commit();
  await refused(f);
});

test('first, minor, major, prerelease and absent prior tags require current judgment', async t => {
  for (const [old, current] of [['1.2.2', '1.3.0'], ['1.2.2', '2.0.0'], ['1.2.2', '1.2.3-rc.1'], ['1.2.2-rc.1', '1.2.3']]) {
    const f = prior(t, old, current); await refused(f);
  }
  const f = prior(t); git(f.repo, 'tag', '-d', f.previous.tag); await refused(f);
});

test('nearest lower patch tag prevents inheritance from an older matching tag', async t => {
  const f = prior(t, '1.2.1', '1.2.2');
  writeFileSync(resolve(f.repo, 'CONTRACT.md'), legacy + '\nDifferent previous contract.\n');
  f.commit(); git(f.repo, 'tag', '-a', 'v1.2.2', '-m', 'v1.2.2');
  version(f, '1.2.3'); writeFileSync(resolve(f.repo, 'CONTRACT.md'), legacy); f.commit();
  await refused(f);
});

test('previous tag must identify an ancestor with coherent metadata and an ordinary contract blob', async t => {
  for (const invalid of ['seed-id', 'seed-version', 'package-version', 'release-version', 'symlink', 'non-ancestor']) {
    const f = prior(t);
    git(f.repo, 'checkout', '--detach', f.previous.commit);
    if (invalid === 'non-ancestor') {
      writeFileSync(resolve(f.repo, 'unrelated.txt'), 'not in the selected ancestry');
    } else if (invalid === 'symlink') {
      git(f.repo, 'update-index', '--cacheinfo', `120000,${f.previous.blob},CONTRACT.md`);
    } else {
      const path = invalid.startsWith('seed-') ? 'seed.json' : invalid === 'package-version' ? 'package.json' : 'RELEASE.json';
      const file = resolve(f.repo, path), data = JSON.parse(readFileSync(file));
      data[invalid === 'seed-id' ? 'id' : 'version'] = invalid === 'seed-id' ? 'other' : '9.9.9';
      writeFileSync(file, JSON.stringify(data));
    }
    if (invalid === 'symlink') git(f.repo, 'commit', '-qm', 'nonordinary historical contract');
    else f.commit();
    git(f.repo, 'tag', '-f', '-a', f.previous.tag, '-m', f.previous.tag);
    // Restore the clean selected patch without inheriting invalid metadata.
    git(f.repo, 'checkout', '--detach', invalid === 'non-ancestor' ? f.previous.commit : 'HEAD');
    git(f.repo, 'read-tree', '--reset', '-u', f.sha);
    version(f, '1.2.3'); writeFileSync(resolve(f.repo, 'CONTRACT.md'), legacy); f.commit();
    await refused(f);
  }
});
