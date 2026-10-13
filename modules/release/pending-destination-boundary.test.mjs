import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { publicationScan } from './publication-scan.mjs';
import { fixture } from './test-fixture.mjs';

const cli = resolve(import.meta.dirname, '../../bin/rer.mjs');
const manifests = ['edition.json', 'rer-project.json'];
const git = (repo, args, input) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
}).trim();

function declaredFixture(t) {
  const f = fixture(t);
  writeFileSync(resolve(f.repo, 'edition.json'), JSON.stringify({ id: f.options.project }));
  writeFileSync(resolve(f.repo, 'rer-project.json'), JSON.stringify({
    projectId: f.options.project, sourceRepository: f.options.repository,
  }));
  f.commit();
  const commands = resolve(f.temporary, 'commands');
  mkdirSync(commands);
  const marker = resolve(f.temporary, 'install-started');
  // Test-only executables: an own-destination 404 and an installer that records invocation.
  const executables = {
    gh: `process.stdout.write('HTTP/2.0 404 Not Found\\n\\n{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}\\n'); process.exit(1);`,
    pnpm: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1);`,
  };
  for (const [name, body] of Object.entries(executables)) {
    const path = resolve(commands, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const prior = process.env.PATH;
  process.env.PATH = commands + ':' + prior;
  t.after(() => { process.env.PATH = prior; });
  return { ...f, marker };
}

function assertRejectedBeforeEffects(f, ref) {
  const report = publicationScan(f.repo, ref, undefined, f.options.project, f.options.repository);
  for (const clean of [false, true]) {
    for (const flags of [[], ['--tag', 'v1.2.3'], ['--tag', 'v1.2.3', '--dry-run']]) {
      const result = spawnSync(process.execPath, [cli, 'release', '--repo', f.repo, '--ref', ref,
        '--project', f.options.project, '--repository', f.options.repository,
        '--output', f.options.output, ...(clean ? ['--clean-history'] : []), ...flags], { encoding: 'utf8' });
      assert.deepEqual({
        publicationStatus: report.status,
        invalidDestination: report.findings.some(item => item.rule === 'destination.invalid'),
        pendingInfo: report.info.some(item => item.rule === 'pending-public-destination'),
        cliExit: result.status,
        installStarted: existsSync(f.marker),
        outputCreated: existsSync(f.options.output),
        tags: git(f.repo, ['tag', '--list']),
      }, {
        publicationStatus: 'FAIL', invalidDestination: true, pendingInfo: false,
        cliExit: 2, installStarted: false, outputCreated: false, tags: '',
      }, JSON.stringify({ clean, flags, stderr: result.stderr }));
    }
  }
}

for (const name of manifests) {
  for (const constant of ['NaN', 'Infinity', '-Infinity']) {
    test(`publication and producer reject ${constant} nested in ${name} before effects`, t => {
      const f = declaredFixture(t);
      const path = resolve(f.repo, name);
      const document = readFileSync(path, 'utf8');
      writeFileSync(path, document.slice(0, -1) + `, "extra": {"values": [${constant}]}}`);
      const ref = f.commit();
      assertRejectedBeforeEffects(f, ref);
    });
  }
}

for (const [names, keepOther] of [
  [['edition.json'], false], [['rer-project.json'], false], [manifests, false],
  [['edition.json'], true], [['rer-project.json'], true],
]) {
  test(`publication and producer reject empty Git trees at ${names.join(', ')}; other declaration ${keepOther ? 'ordinary' : 'absent'}`, t => {
    const f = declaredFixture(t);
    const empty = git(f.repo, ['mktree'], '');
    const removed = keepOther ? names : manifests;
    const entries = git(f.repo, ['ls-tree', 'HEAD']).split('\n')
      .filter(line => !removed.includes(line.split('\t')[1]));
    entries.push(...names.map(name => `040000 tree ${empty}\t${name}`));
    const tree = git(f.repo, ['mktree'], entries.join('\n') + '\n');
    const ref = git(f.repo, ['commit-tree', tree, '-p', 'HEAD', '-m', 'empty declaration tree']);
    // Keep the ordinary declarations in the clean worktree: the selected ref must govern.
    assert.equal(git(f.repo, ['status', '--porcelain']), '');
    for (const name of names) assert.equal(git(f.repo, ['ls-tree', ref, name]), `040000 tree ${empty}\t${name}`);
    assertRejectedBeforeEffects(f, ref);
  });
}
