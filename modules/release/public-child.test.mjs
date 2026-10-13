import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { release } from './produce.mjs';
import { inspectSource } from './source.mjs';
import { assertPublicTree, publicDestination } from './public-child.mjs';
import { publicFixture, git } from './public-child-fixture.mjs';

const absent = f => {
  assert.equal(existsSync(resolve(f.options.output, 'public-git')), false);
  assert.equal(existsSync(resolve(f.options.output, 'public-source.tar')), false);
  assert.equal(existsSync(resolve(f.options.output, 'PUBLISH.md')), false);
  assert.equal(git(f.repo, 'tag', '--list'), '');
};

const body = (repo, type, oid) => git(repo, 'cat-file', type, oid).split('\n\n').slice(1).join('\n\n');

test('public child preserves exact modes/bytes, scans final tag, excludes private objects and writes a bounded handoff', async t => {
  const f = publicFixture(t);
  writeFileSync(resolve(f.repo, 'removed.txt'), 'PRIVATE-only history'); const privateOld = f.commit();
  rmSync(resolve(f.repo, 'removed.txt'));
  writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: '  Public improvements.\n\n# Details\nExact source bytes.  ' }));
  writeFileSync(resolve(f.repo, '.gitattributes'), '*.txt export-ignore\n*.mjs export-subst\n');
  writeFileSync(resolve(f.repo, 'exact.txt'), Buffer.from([0, 13, 10, 255, 42]));
  writeFileSync(resolve(f.repo, 'executable.sh'), '#!/bin/sh\nexit 0\n'); chmodSync(resolve(f.repo, 'executable.sh'), 0o755);
  const privateTip = f.commit();
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'DRY_RUN'); assert.equal(receipt.publicationHistory, 'public-child');
  assert.equal(receipt.publicParent, f.parent); assert.equal(receipt.tag.created, false);
  const out = resolve(f.options.output, 'public-git'), child = receipt.publicExport.commit;
  assert.equal(git(out, 'rev-list', '--parents', '-n', '1', child), `${child} ${f.parent}`);
  assert.equal(git(out, 'rev-list', `${f.parent}..${child}`, '--count'), '1');
  assert.equal(git(out, 'rev-parse', 'HEAD^{tree}'), git(f.repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(git(out, 'ls-tree', 'HEAD', 'executable.sh').slice(0, 6), '100755');
  assert.deepEqual(readFileSync(resolve(out, 'exact.txt')), readFileSync(resolve(f.repo, 'exact.txt')));
  assert.equal(git(out, 'cat-file', '-t', 'v1.2.3'), 'tag');
  assert.equal(git(out, 'rev-parse', 'v1.2.3^{commit}'), child);
  assert.equal(body(out, 'commit', child), 'v1.2.3\n\nPublic improvements.\n\n# Details\nExact source bytes.');
  assert.equal(body(out, 'tag', 'v1.2.3'), body(out, 'commit', child));
  assert.equal(git(f.repo, 'tag', '--list'), ''); assert.equal(git(out, 'remote'), '');
  for (const privateCommit of [privateOld, privateTip]) {
    assert.equal(git(out, 'rev-list', '--all').includes(privateCommit), false);
    assert.notEqual(spawnSync('git', ['-C', out, 'cat-file', '-e', privateCommit]).status, 0);
  }
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.equal(report.status, 'PASS'); assert.equal(report.complete, true); assert.equal(report.guarantees.historyScanned, true);
  assert.equal(report.publicBase.commit, f.parent); assert.equal(report.source.commit, child);
  const site = JSON.parse(readFileSync(resolve(f.options.output, receipt.siteRelease.path)));
  assert.equal(site.provenance.revision, child);
  const handoff = readFileSync(resolve(f.options.output, 'PUBLISH.md'), 'utf8');
  assert.match(handoff, /set -eu/); assert.match(handoff, /ls-remote --refs/); assert.match(handoff, /push --atomic --no-follow-tags/);
  assert.ok(handoff.includes(`${child}:refs/heads/main`)); assert.ok(handoff.includes(`${receipt.publicExport.tagObject}:refs/tags/v1.2.3`));
  assert.doesNotMatch(handoff, /--force|--mirror|--all|--tags/);
  assert.equal(git(f.bare, 'rev-parse', 'main'), f.parent); assert.equal(git(f.bare, 'tag', '--list'), '');
  // Exercise every handoff guard from the wrong cwd, excluding its push line.
  const commands = handoff.split('```sh\n')[1].split('\n```')[0];
  const guards = commands.split('\n').filter(line => !line.startsWith('release_git push ')).join('\n');
  const checked = spawnSync('sh', ['-c', guards], { cwd: f.temporary, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  writeFileSync(resolve(f.options.output, 'release-receipt.json'), '{}');
  assert.notEqual(spawnSync('sh', ['-c', guards], { cwd: f.temporary }).status, 0);
});

test('non-dry public child retains a private source tag and public site identity', async t => {
  const f = publicFixture(t); writeFileSync(resolve(f.repo, 'README.md'), 'Released product.\n'); const source = f.commit();
  const receipt = await release(f.options);
  assert.equal(receipt.status, 'RELEASED'); assert.equal(receipt.tag.created, true);
  assert.equal(git(f.repo, 'rev-parse', 'v1.2.3^{commit}'), source);
  assert.notEqual(receipt.publicExport.commit, source);
  assert.equal(git(f.bare, 'rev-parse', 'main'), f.parent);
});

test('dry run preserves an existing private version tag while staging the actual public tag', async t => {
  const f = publicFixture(t); git(f.repo, 'tag', '-a', 'v1.2.3', '-m', 'Private annotation');
  const privateTag = git(f.repo, 'rev-parse', 'v1.2.3');
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'DRY_RUN'); assert.equal(git(f.repo, 'rev-parse', 'v1.2.3'), privateTag);
  assert.equal(body(resolve(f.options.output, 'public-git'), 'tag', 'v1.2.3'), 'v1.2.3');
});

test('public destination syntax, identity, visibility, remote tag and ambiguity fail before output', async t => {
  const f = publicFixture(t);
  for (const onto of ['main', 'https://github.com/octocat/Hello-World', 'https://user:test-pass@github.com/octocat/Hello-World#main',
    'https://github.com/octocat/Spoon-Knife#main', 'https://github.com/octocat/Hello-World#HEAD', 'https://github.com/octocat/Hello-World#refs/heads/main',
    'https://github.com/octocat/Hello-World#bad..branch', 'https://github.com/octocat/Hello-World#main#extra', 'https://github.com/octocat/Hello-World#-branch']) {
    assert.throws(() => publicDestination(onto, f.options.repository, f.repo));
  }
  await assert.rejects(release({ ...f.options, cleanHistory: true })); absent(f);
  for (const visibility of ['private', 'missing', 'unresolved']) {
    f.configure({ visibility }); await assert.rejects(release(f.options)); absent(f);
  }
  f.configure({ visibility: 'public', ambiguous: true }); await assert.rejects(release(f.options)); absent(f);
  f.configure({ ambiguous: false }); git(f.bare, 'update-ref', 'refs/tags/v1.2.3', f.parent);
  await assert.rejects(release(f.options)); absent(f);
});

for (const mode of ['moveTo', 'removeHead', 'addTag', 'unresolvedAfter', 'ambiguousAfter']) {
  test(`post-scan remote ${mode} refuses every publishable artifact`, async t => {
    const f = publicFixture(t);
    writeFileSync(resolve(f.repo, 'README.md'), 'Another public tip.'); const changed = f.commit();
    git(f.repo, 'push', f.bare, 'HEAD:refs/heads/other');
    f.configure({ [mode]: mode === 'moveTo' ? changed : mode === 'addTag' ? f.parent : true });
    await assert.rejects(release({ ...f.options, dryRun: true })); absent(f);
    assert.equal(existsSync(resolve(f.options.output, 'release-receipt.json')), false);
  });
}

test('real index corruption refuses the export and tree identity assertion rejects a different commit tree', async t => {
  const f = publicFixture(t);
  writeFileSync(resolve(f.repo, 'README.md'), 'Different private tree'); f.commit();
  assert.throws(() => assertPublicTree(f.repo, f.parent, inspectSource(f.repo, 'HEAD').tree));
  f.configure({ corruptTree: true }); await assert.rejects(release(f.options)); absent(f);
});

test('actual final release notes are scanned before handoff and blocked notes expose no archive or tag', async t => {
  const f = publicFixture(t);
  writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: ['', 'Users', 'test-person', 'test-workspace'].join('/') })); f.commit();
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.gates.publishCheck.status, 'FAIL'); absent(f);
  const report = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json')));
  assert.ok(report.findings.some(f => f.path === '@commit-message'));
  assert.ok(report.findings.some(f => f.path === '@tag-message'));
});

test('producer rejects a PASS report naming a different public child before artifacts or private tag', async t => {
  const f = publicFixture(t);
  const originalNode = process.execPath;
  const genuineReportPath = resolve(f.temporary, 'genuine-public-child-report.json');
  const scannerRefPath = resolve(f.temporary, 'scanner-ref.json');
  const wrongCommit = f.parent;
  const wrapper = resolve(f.temporary, 'tamper-scanner-report.py');
  writeFileSync(wrapper, `#!/usr/bin/env python3
import json
import os
import subprocess
import sys

node = ${JSON.stringify(originalNode)}
report_path = ${JSON.stringify(genuineReportPath)}
ref_path = ${JSON.stringify(scannerRefPath)}
wrong_commit = ${JSON.stringify(wrongCommit)}
args = sys.argv[1:]
if any(arg.endswith("scripts/publish-check.mjs") for arg in args):
    result = subprocess.run([node, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    sys.stderr.buffer.write(result.stderr)
    report = json.loads(result.stdout)
    with open(report_path, "w", encoding="utf-8") as stream:
        json.dump(report, stream)
    with open(ref_path, "w", encoding="utf-8") as stream:
        json.dump({"ref": args[args.index("--ref") + 1], "sourceCommit": report["source"]["commit"]}, stream)
    report.setdefault("source", {})["commit"] = wrong_commit
    sys.stdout.write(json.dumps(report))
    sys.exit(result.returncode)
os.execv(node, [node, *args])
  `);
  chmodSync(wrapper, 0o755);
  const runner = resolve(f.temporary, 'run-tampered-release.mjs');
  writeFileSync(runner, `import { pathToFileURL } from 'node:url';
const { release } = await import(pathToFileURL(${JSON.stringify(resolve(import.meta.dirname, 'produce.mjs'))}).href);
process.execPath = ${JSON.stringify(wrapper)};
const receipt = await release(${JSON.stringify(f.options)});
process.stdout.write(JSON.stringify(receipt));
`);
  const result = spawnSync(originalNode, [runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);

  const genuine = JSON.parse(readFileSync(genuineReportPath, 'utf8'));
  assert.equal(genuine.status, 'PASS', JSON.stringify(genuine));
  assert.equal(genuine.complete, true);
  assert.equal(genuine.guarantees.historyScanned, true);
  assert.equal(genuine.publicBase.commit, f.parent);
  const scannerRef = JSON.parse(readFileSync(scannerRefPath, 'utf8'));
  assert.equal(genuine.source.commit, scannerRef.ref);
  assert.equal(genuine.source.commit, scannerRef.sourceCommit);
  assert.notEqual(genuine.source.commit, wrongCommit);
  assert.notEqual(genuine.source.commit, f.sha);

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.gates.publishCheck.status, 'INCOMPLETE');
  assert.equal(receipt.publicExport, null);
  assert.equal(receipt.tag.created, false);
  const persisted = JSON.parse(readFileSync(resolve(f.options.output, 'publish-check.json'), 'utf8'));
  assert.equal(persisted.status, 'INCOMPLETE');
  assert.equal(persisted.source.commit, wrongCommit);
  assert.equal(persisted.complete, false);
  assert.equal(persisted.guarantees.historyScanned, false);
  absent(f);
  assert.equal(git(f.bare, 'rev-parse', 'main'), f.parent);
  assert.equal(git(f.bare, 'tag', '--list'), '');
});

test('real verify mutation blocks public child artifacts', async t => {
  const f = publicFixture(t, 'node -e "require(\'node:fs\').writeFileSync(\'README.md\',\'mutated\')"');
  const receipt = await release({ ...f.options, dryRun: true });
  assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.gates.verify.reason, 'verify-changed-tracked-source'); absent(f);
});

test('CLI accepts onto dry-run with the committed explicit tag and preserves untagged preview behavior', async t => {
  const f = publicFixture(t), cli = resolve(import.meta.dirname, '../../bin/rer.mjs');
  const args = [cli, 'release', '--repo', f.repo, '--project', f.options.project, '--repository', f.options.repository,
    '--output', f.options.output, '--onto', f.options.onto, '--dry-run', '--tag', 'v1.2.3'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).publicationHistory, 'public-child');
  assert.equal(git(f.repo, 'tag', '--list'), '');
  const output = resolve(f.temporary, 'preview');
  const receipt = await release({ ...f.options, output, tag: false });
  assert.equal(receipt.status, 'DRY_RUN'); assert.equal(receipt.publicExport, null);
  assert.equal(existsSync(resolve(output, 'PUBLISH.md')), false);
});

test('a head moved during artifact preparation is refused before the private source tag', async t => {
  const f = publicFixture(t);
  writeFileSync(resolve(f.repo, 'README.md'), 'A changed public tip.'); const changed = f.commit();
  git(f.repo, 'push', f.bare, 'HEAD:refs/heads/other');
  f.configure({ moveTo: changed, changeAt: 3 });
  await assert.rejects(release(f.options)); absent(f);
  assert.equal(existsSync(resolve(f.options.output, 'release-receipt.json')), false);
});
