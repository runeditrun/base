import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {githubApiEdge} from '../../edition-authoring/tests/github-api.mjs';

export async function apiArchiveJourney(t, {fixture, write, commit, git}) {
 const {seed, source, revision, result, old, run, env} = await fixture(t);
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

 const responses = {};
 for (const pin of [revision, beforeIntroduction, introduced, target]) {
  const tree = git(source, 'rev-parse', pin + '^{tree}');
  responses['git/commits/' + pin] = {sha: pin, tree: {sha: tree}};
  // Serve real immutable Git objects at the existing gh process edge.
  const entries = git(source, 'ls-tree', '-rz', '--full-tree', pin).split('\0').filter(Boolean).map(line => {
   const [mode, type, sha, name] = line.split(/[\t ]/);
   return {path: name, mode, type, sha};
  });
  responses['git/trees/' + tree + '?recursive=1'] = {sha: tree, truncated: false, tree: entries};
  for (const entry of entries) {
   const data = execFileSync('git', ['-C', source, 'cat-file', 'blob', entry.sha]);
   responses['git/blobs/' + entry.sha] = {sha: entry.sha, encoding: 'base64', size: data.length, content: data.toString('base64')};
  }
 }
 const compare = (ancestor, status, merge = ancestor) => ({base_commit: {sha: ancestor}, merge_base_commit: {sha: merge}, status});
 const targetComparison = 'compare/' + introduced + '...' + target + '?per_page=1';
 const oldComparison = 'compare/' + introduced + '...' + beforeIntroduction + '?per_page=1';
 responses[targetComparison] = compare(introduced, 'ahead');
 responses[oldComparison] = compare(introduced, 'behind', beforeIntroduction);
 responses['compare/' + beforeIntroduction + '...' + target + '?per_page=1'] = compare(beforeIntroduction, 'ahead');
 responses['compare/' + beforeIntroduction + '...' + beforeIntroduction + '?per_page=1'] = compare(beforeIntroduction, 'identical');
 const tools = path.join(path.dirname(source), 'api-tools'), edge = githubApiEdge(tools, responses);
 env.PATH = tools + path.delimiter + env.PATH;
 const refused = run('refresh-base', '--ref', target, '--from-api');
 assert.equal(refused.status, 4, refused.stdout + refused.stderr);
 assert.match(message(refused), /Edition migrations require consent/);
 assert.match(message(refused), /run-data-pricing/);
 assert.match(message(refused), /--from-api.*--edition-migration run-data-pricing/);
 assert.deepEqual(snapshot(), before, 'API consent refusal changes no bytes, modes or records');
 const checkout = run('refresh-base', '--ref', target, '--base', source);
 assert.equal(checkout.status, 4);
 assert.match(message(checkout), /run-data-pricing/);
 assert.deepEqual(snapshot(), before);
 const expected = result('refresh-base', '--ref', target, '--base', source, '--edition-migration', 'run-data-pricing');
 const afterCheckout = snapshot();
 // Return to the exact same unadapted seed before using the API source.
 for (const name of Object.keys(snapshot())) if (!Object.hasOwn(before, name)) fs.rmSync(path.join(seed, name));
 for (const [name, [data, mode]] of Object.entries(before)) {
  write(seed, name, Buffer.from(data, 'base64')); fs.chmodSync(path.join(seed, name), mode);
 }
 assert.deepEqual(fs.readFileSync(path.join(seed, local)), bytes);
 assert.deepEqual(fs.readFileSync(path.join(seed, 'base-copies.json')), record);
 // Provider failure, unknown ancestry, and invalid proofs all refuse, even with consent.
 for (const change of [
  values => { delete values[oldComparison]; },
  values => { values[targetComparison].status = 'unknown'; },
  values => { values[targetComparison].merge_base_commit.sha = beforeIntroduction; },
  values => { values['git/commits/' + target].sha = introduced; },
  values => { values['git/trees/' + git(source, 'rev-parse', target + '^{tree}') + '?recursive=1'].sha = introduced; },
  values => { values['git/blobs/' + git(source, 'rev-parse', target + ':' + origin)].content = Buffer.from('changed').toString('base64'); },
 ]) {
  const values = structuredClone(responses); change(values); edge.save(values);
  const invalid = run('refresh-base', '--ref', target, '--from-api', '--edition-migration', 'run-data-pricing');
  assert.equal(invalid.status, 4, invalid.stdout + invalid.stderr);
  if (!Object.hasOwn(values, oldComparison)) assert.match(message(invalid), /GitHub API \(HTTP 404\)/);
  assert.deepEqual(snapshot(), before);
 }
 edge.save(responses);
 for (const flags of [['--offline'], ['--base', source], ['--base-archive', archive]]) {
  assert.equal(run('refresh-base', '--ref', target, '--from-api', ...flags).status, 4);
  assert.deepEqual(snapshot(), before);
 }
 const unrelated = structuredClone(responses); delete unrelated[targetComparison]; edge.save(unrelated);
 assert.equal(run('refresh-base', '--ref', target, '--from-api', '--edition-migration', 'run-data-pricing').status, 4);
 assert.deepEqual(snapshot(), before);
 // Compare status diverged also does not prove introduction in the old copy.
 const diverged = structuredClone(responses);
 diverged[oldComparison].status = 'diverged'; edge.save(diverged);
 assert.match(message(run('refresh-base', '--ref', target, '--from-api')), /run-data-pricing/);
 assert.deepEqual(snapshot(), before);
 // Truncated recursive responses are completed through immutable child trees.
 const fallback = structuredClone(responses), rootTree = git(source, 'rev-parse', target + '^{tree}');
 fallback['git/trees/' + rootTree + '?recursive=1'] = {sha: rootTree, truncated: true, tree: []};
 const addTree = identity => {
  const entries = git(source, 'ls-tree', '-z', identity).split('\0').filter(Boolean).map(line => {
   const [mode, type, sha, name] = line.split(/[\t ]/); return {path: name, mode, type, sha};
  });
  fallback['git/trees/' + identity] = {sha: identity, truncated: false, tree: entries};
  fallback['git/trees/' + identity + '?recursive=1'] ??= {sha: identity, truncated: true, tree: []};
  for (const entry of entries) if (entry.type === 'tree') addTree(entry.sha);
 };
 addTree(rootTree); edge.save(fallback);
 const actual = result('refresh-base', '--ref', target, '--from-api', '--edition-migration', 'run-data-pricing');
 assert.deepEqual(actual, expected);
 assert.deepEqual(snapshot(), afterCheckout, 'API and full-history refresh have identical source, records and modes');
 assert.deepEqual(actual.editionMigrations.map(step => step.id), ['run-data-pricing']);
 const repeat = result('refresh-base', '--ref', target, '--from-api');
 assert.deepEqual(repeat.editionMigrations, []);
 assert.equal(repeat.copies.flatMap(copy => copy.added).length, 0);
 assert.deepEqual(snapshot(), afterCheckout);
 old('verify-base', '--offline');
 assert.ok(edge.requests().some(args => args[1] === 'repos/runeditrun/base/' + targetComparison));
 assert.ok(edge.requests().every(args => args[0] === 'api' && !args[1].includes('/main')));
 t.diagnostic('API archive: before exit=4 no Git history; without consent exit=4 naming run-data-pricing; consent exit=0 matches full-history; repeat adds=0; unknown/unrelated API ancestry and corrupt objects refuse before writes; consent adds=' + actual.copies.flatMap(copy => copy.added).length + '; consent migrations=' + actual.editionMigrations.length + '; repeat migrations=' + repeat.editionMigrations.length);
}
