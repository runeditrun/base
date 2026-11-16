import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {githubAcquisitionEdge} from '../../edition-authoring/tests/github-acquisition.mjs';

export async function apiArchiveJourney(t, {fixture, write, commit, git}) {
 const {seed, source, result, old, run, env} = await fixture(t);
 const origin = 'foundation/runtime/run-site.ts', local = 'src/base/run-site.ts';
 write(source, origin, 'export const runSite = {paths: true};\n');
 fs.chmodSync(path.join(source, origin), 0o755);
 const beforeIntroduction = commit(source);
 write(seed, local, fs.readFileSync(path.join(source, origin)));
 fs.chmodSync(path.join(seed, local), 0o755);
 old('record-base', local, origin, beforeIntroduction, '--base', source);
 const legacy = JSON.parse(fs.readFileSync(path.join(seed, 'base-copies.json')));
 for (const copy of legacy.copies) delete copy.originFiles;
 write(seed, 'base-copies.json', JSON.stringify(legacy));
 commit(seed);
 write(source, origin, 'export const runSite = {paths: true, pricing: true};\n');
 write(source, 'foundation/runtime/run-pricing.ts', 'export const runPricing = {};\n');
 const introduced = commit(source);
 write(source, 'foundation/edition-migrations.json', JSON.stringify({schemaVersion: 1, migrations: [{
  id: 'run-data-pricing', introduced, origin, guide: 'export/SEED-COMMAND-CONTRACT.md',
  edit: 'Add pricing to edition RunData.', deliver: ['foundation/runtime/run-pricing.ts'],
 }, {id: 'run-data-paths', introduced: beforeIntroduction, origin, guide: 'guide.md', edit: 'Already introduced.', deliver: []}]}));
 for (let i = 0; i < 200; i++) write(source, `unrelated/file-${i}.txt`, `synthetic unrelated source ${i}\n`);
 const target = commit(source);
 const archive = source + '-archive';
 fs.mkdirSync(archive);
 execFileSync('tar', ['-xf', '-', '-C', archive], {input: execFileSync('git', ['-C', source, 'archive', target])});
 const record = fs.readFileSync(path.join(seed, 'base-copies.json')), bytes = fs.readFileSync(path.join(seed, local));
 const snapshot = () => Object.fromEntries(git(seed, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort().map(name => [
  name, [fs.readFileSync(path.join(seed, name)).toString('base64'), fs.statSync(path.join(seed, name)).mode & 0o777],
 ]));
 const before = snapshot();
 const message = response => response.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'error')?.message;
 const directory = run('refresh-base', '--ref', target, '--base-archive', archive);
 assert.equal(directory.status, 4);
 assert.match(message(directory), /archive has no Git history/);
 assert.deepEqual(snapshot(), before);

 git(source, 'config', 'uploadpack.allowFilter', 'true');
 git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
 const tools = path.join(path.dirname(source), 'api-tools'), edge = githubAcquisitionEdge(tools);
 env.PATH = tools + path.delimiter + env.PATH;
 const refused = run('refresh-base', '--ref', target, '--from-api');
 assert.equal(refused.status, 4, refused.stdout + refused.stderr);
 assert.match(message(refused), /Edition migrations require consent/);
 assert.match(message(refused), /--from-api.*--edition-migration run-data-pricing/);
 assert.deepEqual(snapshot(), before, 'consent refusal changes no bytes, modes or records');
 const checkout = run('refresh-base', '--ref', target, '--base', source);
 assert.equal(checkout.status, 4);
 assert.match(message(checkout), /run-data-pricing/);
 assert.deepEqual(snapshot(), before);
 const expected = result('refresh-base', '--ref', target, '--base', source, '--edition-migration', 'run-data-pricing');
 const afterCheckout = snapshot();
 for (const name of Object.keys(snapshot())) if (!Object.hasOwn(before, name)) fs.rmSync(path.join(seed, name));
 for (const [name, [data, mode]] of Object.entries(before)) {
  write(seed, name, Buffer.from(data, 'base64')); fs.chmodSync(path.join(seed, name), mode);
 }
 assert.deepEqual(fs.readFileSync(path.join(seed, local)), bytes);
 assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
 for (const flags of [['--offline'], ['--base', source], ['--base-archive', archive]]) {
  assert.equal(run('refresh-base', '--ref', target, '--from-api', ...flags).status, 4);
  assert.deepEqual(snapshot(), before);
 }
 edge.failFetch(true);
 const failure = run('refresh-base', '--ref', target, '--from-api', '--edition-migration', 'run-data-pricing');
 assert.equal(failure.status, 4);
 assert.ok(message(failure).includes('https://github.com/runeditrun/base.git ' + target));
 assert.doesNotMatch(failure.stdout + failure.stderr, /private transport diagnostic/);
 assert.deepEqual(snapshot(), before);
 edge.failFetch(false);
 const start = edge.requests().length;
 const actual = result('refresh-base', '--ref', target, '--from-api', '--edition-migration', 'run-data-pricing');
 const requests = edge.requests().slice(start);
 assert.ok(requests.filter(args => args[0] === 'api').length <= 10, 'REST requests stay bounded independently of tree size');
 assert.ok(requests.some(args => args[0] === 'fetch'), 'real Git pack acquisition runs at the process edge');
 assert.deepEqual(actual, expected);
 assert.deepEqual(snapshot(), afterCheckout, 'source, copies and edition metadata are byte-identical to the checkout path');
 assert.deepEqual(actual.editionMigrations.map(step => step.id), ['run-data-pricing']);
 const repeat = result('refresh-base', '--ref', target, '--from-api');
 assert.deepEqual(repeat.editionMigrations, []);
 assert.equal(repeat.copies.flatMap(copy => copy.added).length, 0);
 assert.deepEqual(snapshot(), afterCheckout);
 old('verify-base', '--offline');
 // Unavailable ancestry still refuses with the exact immutable request.
 const migrationData = fs.readFileSync(path.join(source, 'foundation/edition-migrations.json'));
 const unavailable = execFileSync('git', ['-C', source, 'hash-object', '--stdin'], {input: 'synthetic unavailable introduction', encoding: 'utf8'}).trim();
 const invalid = JSON.parse(migrationData.toString()); invalid.migrations[0].introduced = unavailable;
 write(source, 'foundation/edition-migrations.json', JSON.stringify(invalid));
 const invalidPin = commit(source), unknownBefore = snapshot();
 const unknown = run('refresh-base', '--ref', invalidPin, '--from-api', '--edition-migration', 'run-data-pricing');
 assert.equal(unknown.status, 4);
 assert.ok(message(unknown).includes(unavailable));
 assert.deepEqual(snapshot(), unknownBefore);
 // Having full Git ancestry must not broaden snapshot-only workflow adoption.
 write(source, 'foundation/edition-migrations.json', migrationData);
 write(source, 'export/verify.yml', 'jobs: {}\n'); commit(source);
 write(seed, '.github/workflows/verify.yml', 'jobs: {}\n'); commit(seed);
 write(source, 'export/verify.yml', 'name: Verify\njobs: {}\n');
 const workflowPin = commit(source), workflowBefore = fs.readFileSync(path.join(seed, '.github/workflows/verify.yml'));
 const workflow = result('refresh-base', '--ref', workflowPin, '--from-api');
 assert.deepEqual(workflow.templateAdoptions, []);
 assert.deepEqual(fs.readFileSync(path.join(seed, '.github/workflows/verify.yml')), workflowBefore);
 assert.ok(workflow.notices.some(notice => notice.includes('.github/workflows/verify.yml')));
 t.diagnostic('GitHub acquisition: REST calls=' + requests.filter(args => args[0] === 'api').length + '; Git pack fetches=' + requests.filter(args => args[0] === 'fetch').length + '; consent, atomic transport refusal, byte equality and repeat passed');
}
