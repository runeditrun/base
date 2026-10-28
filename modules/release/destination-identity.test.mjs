import { caseRows } from '../deploy-kit/tests/fold-case.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture } from './test-fixture.mjs';

const responseCaseRows = [];
const responseCase = (name, run) => responseCaseRows.push({name,run});
const destinationCaseRows = [];
const destinationCase = (name, run) => destinationCaseRows.push({name,run});

const cli = resolve(import.meta.dirname, '../../bin/rer.mjs');
const project = 'catalogue-publisher/product';
const repository = 'octocat/hello-world';
const url = 'https://github.com/' + repository;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const modes = [
  { name: 'source history', flags: [] },
  { name: 'staged annotation', flags: ['--tag'] },
  { name: 'parentless export', flags: ['--tag', '--clean-history'] },
];

function source(t, declared, repositoryState) {
  const f = fixture(t);
  const notes = 'Public source: ' + url;
  writeFileSync(resolve(f.repo, 'README.md'), notes);
  writeFileSync(resolve(f.repo, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', publicReleaseNotes: notes }));
  if (declared) {
    writeFileSync(resolve(f.repo, 'edition.json'), JSON.stringify({ id: project, custody: { repository: url + '.git' } }));
    writeFileSync(resolve(f.repo, 'rer-project.json'), JSON.stringify({ projectId: project, sourceRepository: url }));
  }
  const commit = f.commit();
  return { ...f, source: commit, ...githubFixture(f.temporary, repositoryState) };
}

function githubFixture(temporary, repositoryState) {
  // Only the API is synthetic; the CLI installs the locked source and runs its actual verify.
  const commands = resolve(temporary, 'commands'); mkdirSync(commands);
  // The extensionless executable must not inherit an enclosing TMPDIR package's module type.
  writeFileSync(resolve(commands, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const executable = resolve(commands, 'gh');
  const calls = resolve(temporary, 'api-calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
// A GraphQL batch names each repository as owner (oN) and name (nN) variables.
const fields = Object.fromEntries(args.flatMap((arg, i) => arg === '-f' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
const references = args.includes('graphql')
  ? Object.keys(fields).filter(key => /^o\\d+$/.test(key)).map(key => [key.slice(1), fields[key] + '/' + fields['n' + key.slice(1)]])
  : [[null, args.at(-1).replace('repos/', '')]];
for (const [, reference] of references) fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(reference) + '\\n');
if (references.some(([, reference]) => ![${JSON.stringify(project)}, ${JSON.stringify(repository)}].includes(reference))) process.exit(2);
const states = references.map(([index, reference]) => [index, reference, reference === ${JSON.stringify(repository)} ? ${JSON.stringify(repositoryState)} : 'public']);
const answer = (code, body) => {
  process.stdout.write('HTTP/2.0 ' + code + ' Result\\r\\nContent-Type: application/json\\r\\n\\r\\n' + body);
  process.stderr.write('private-gh-diagnostic');
};
if (args.includes('graphql') && states.every(([, , state]) => ['public', 'private', 'missing'].includes(state))) {
  const data = {}, errors = [];
  for (const [index, reference, state] of states) {
    data['r' + index] = state === 'missing' ? null : { isDisabled: false, isLocked: false, isPrivate: state === 'private' };
    if (state === 'missing') errors.push({ type: 'NOT_FOUND', path: ['r' + index], message: "Could not resolve to a Repository with the name '" + reference + "'." });
  }
  answer(200, JSON.stringify(errors.length ? { data, errors } : { data }));
  process.exit(errors.length ? 1 : 0);
}
// A broken batch answers as its broken repository would over REST.
const state = states.map(([, , state]) => state).find(state => !['public', 'private'].includes(state)) ?? states[0][2];
const code = ['missing', 'empty', 'malformed'].includes(state) ? 404 : state === 'unavailable' ? 503 : 200;
answer(code, state === 'empty' ? '' : state === 'malformed' ? '{broken' : JSON.stringify(code === 404
  ? { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository', status: '404' }
  : { private: state === 'private' }));
process.exit(code === 200 ? 0 : 1);
`);
  chmodSync(executable, 0o755);
  return { executable, calls, env: { ...process.env, PATH: commands + ':' + process.env.PATH } };
}

const responses = [
  ['public', 'public', 200, '{"private":false}'],
  ['private', 'private', 200, '{"private":true}'],
  ['missing', 'missing', 404, JSON.stringify({ message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository', status: '404' })],
  ['empty', 'incomplete', 404, ''],
  ['malformed', 'incomplete', 404, '{broken'],
  ['unavailable', 'incomplete', 503, '{"private":false}'],
];

for (const type of ['module', 'commonjs']) {
  for (const [state, visibility, code, body] of responses) {
    responseCase(`generated GitHub ${state} response works inside a ${type} package`, t => {
      const temporary = mkdtempSync(resolve(tmpdir(), 'rer-destination-api-'));
      t.after(() => rmSync(temporary, { recursive: true, force: true }));
      writeFileSync(resolve(temporary, 'package.json'), JSON.stringify({ type }));
      const f = githubFixture(temporary, state);
      const response = spawnSync(f.executable,
        ['api', '--hostname', 'github.com', '--include', 'repos/' + repository], { encoding: 'utf8' });
      assert.equal(response.status, code === 200 ? 0 : 1);
      assert.equal(response.stdout, `HTTP/2.0 ${code} Result\r\nContent-Type: application/json\r\n\r\n${body}`);
      assert.equal(response.stderr, 'private-gh-diagnostic');
      const resolved = spawnSync('python3', ['-B', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from github_refs import GitHubResolver
resolver = GitHubResolver()
print(json.dumps([resolver.resolve(sys.argv[2]), resolver.resolve(sys.argv[2]),
                  resolver.resolve(sys.argv[3]), resolver.cache]))
`, resolve(import.meta.dirname, '../../scripts/publish-check'), repository, project],
      { encoding: 'utf8', env: f.env });
      assert.equal(resolved.status, 0);
      assert.equal(resolved.stderr, '');
      assert.ok(!resolved.stdout.includes('private-gh-diagnostic'));
      assert.deepEqual(JSON.parse(resolved.stdout), [visibility, visibility, 'public',
        { [repository]: visibility, [project]: 'public' }]);
      assert.equal(readFileSync(f.calls, 'utf8'), [repository, repository, project].map(JSON.stringify).join('\n') + '\n');
    });
  }
}

function run(f, mode) {
  const result = spawnSync(process.execPath, [cli, 'release', '--repo', f.repo,
    '--project', project, '--repository', url + '.git', '--output', f.options.output,
    '--dry-run', '--local-verify', ...mode.flags], { encoding: 'utf8', env: f.env });
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('private-gh-diagnostic'));
  const receipt = JSON.parse(result.stdout);
  const report = read(resolve(f.options.output, 'publish-check.json'));
  assert.equal(receipt.source.commit, f.source);
  assert.equal(receipt.tag.created, false);
  assert.equal(receipt.tag.pushed, false);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(receipt.gates.verify.status, 'PASS');
  assert.equal(receipt.gates.verify.passed, 1);
  return { result, receipt, report };
}

for (const mode of modes) {
  for (const [declared, state] of [[true, 'public'], [true, 'missing'], [false, 'public']]) {
    destinationCase(`${declared ? 'declared' : 'legacy'} distinct identity with ${state} source completes ${mode.name} dry run`, t => {
      const f = source(t, declared, state);
      const { result, receipt, report } = run(f, mode);
      assert.equal(result.status, 0, JSON.stringify(receipt));
      assert.equal(receipt.status, 'DRY_RUN');
      assert.equal(report.status, 'PASS');
      assert.equal(report.complete, true);
      assert.deepEqual(report.findings, []);
      assert.equal(Boolean(report.info.length), state === 'missing');
      assert.equal(existsSync(resolve(f.options.output, 'public-source.tar')), mode.flags.includes('--tag'));
      const catalogue = read(resolve(f.options.output, receipt.siteRelease.path));
      assert.equal(catalogue.project, project);
      assert.equal(catalogue.listing.repository, url + '.git');
      assert.equal(catalogue.provenance.repository, url + '.git');
      const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(new Set(calls), new Set(declared ? [project, repository] : [repository]));
      if (mode.flags.includes('--tag')) {
        const annotation = mode.flags.includes('--clean-history') ? report : report.annotationInspection;
        assert.equal(annotation.status, 'PASS');
        assert.equal(annotation.history.tagMessages, 1);
        assert.equal(annotation.info.some(item => item.path === '@tag-message'), state === 'missing');
      }
      if (mode.flags.includes('--clean-history')) {
        const exported = resolve(f.options.output, 'public-git');
        assert.equal(git(exported, 'rev-list', '--all', '--count'), '1');
        assert.equal(git(exported, 'rev-parse', 'HEAD^{tree}'), receipt.source.tree);
        assert.equal(catalogue.provenance.revision, receipt.publicExport.commit);
        assert.notEqual(receipt.publicExport.commit, f.source);
      }
    });
  }
}

for (const [declared, state, status, rule] of [
  [false, 'missing', 'FAIL', 'hygiene.github-missing'],
  [true, 'private', 'FAIL', 'hygiene.github-private'],
  [true, 'empty', 'INCOMPLETE', 'scan.github-incomplete'],
  [true, 'malformed', 'INCOMPLETE', 'scan.github-incomplete'],
  [true, 'unavailable', 'INCOMPLETE', 'scan.github-incomplete'],
]) {
  destinationCase(`${declared ? 'declared' : 'legacy'} distinct identity with ${state} source blocks clean dry run`, t => {
    const f = source(t, declared, state);
    const { result, receipt, report } = run(f, modes[2]);
    assert.equal(result.status, 1);
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(receipt.publicExport, null);
    assert.equal(report.status, status);
    assert.deepEqual(report.info, []);
    assert.ok(report.findings.some(item => item.rule === rule));
    assert.equal(existsSync(resolve(f.options.output, 'public-source.tar')), false);
    assert.equal(existsSync(resolve(f.options.output, 'public-git')), false);
  });
}

test('GitHub response classification preserves public, private, missing and incomplete evidence across package modes', async (t) => {
  await caseRows(t, responseCaseRows.map(({name,run}) => [name,run]));
});

test('publication destination admission binds distinct identities across history modes and refuses unsafe evidence', async (t) => {
  await caseRows(t, destinationCaseRows.map(({name,run}) => [name,run]));
});
