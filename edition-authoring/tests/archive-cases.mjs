import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Exercise archives through the same CLI used by edition authors, alongside
// the existing copied-source journey rather than adding another test unit.
export function archiveSourceCases(temp, run, snapshotTree) {
  const area = path.join(temp, 'archive-case');
  fs.mkdirSync(area);
  const base = path.join(area, 'base'), checkout = path.join(area, 'checkout-edition'), archived = path.join(area, 'archive-edition');
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
  const write = (root, name, bytes) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), bytes); };
  const init = root => { fs.mkdirSync(root); git(root, 'init', '--quiet'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid'); };
  const commit = root => { git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'fixture'); return git(root, 'rev-parse', 'HEAD'); };
  const ok = (root, ...args) => { const result = run(root, ...args); assert.equal(result.status, 0, result.error); return result.report; };
  function archive(revision, name) {
    const output = path.join(area, name);
    fs.mkdirSync(output);
    const bytes = execFileSync('git', ['-C', base, 'archive', revision], {stdio: 'pipe'});
    execFileSync('tar', ['-xf', '-', '-C', output], {input: bytes, stdio: ['pipe', 'pipe', 'pipe']});
    return output;
  }
  const record = root => fs.readFileSync(path.join(root, 'base-copies.json'), 'utf8');
  const equalEditions = () => assert.deepEqual(snapshotTree(archived), snapshotTree(checkout));
  init(base);
  write(base, 'modules/sample/index.mjs', 'export const sample = 1;\n');
  write(base, 'modules/sample/omitted.mjs', 'export const omitted = true;\n');
  write(base, 'modules/sample/data.bin', Buffer.from([0, 255, 13, 10, 1]));
  fs.chmodSync(path.join(base, 'modules/sample/index.mjs'), 0o755);
  const first = commit(base), initialArchive = archive(first, 'initial-archive');
  for (const root of [checkout, archived]) {
    init(root);
    for (const name of ['index.mjs', 'data.bin']) {
      fs.mkdirSync(path.join(root, 'vendor/sample'), {recursive: true});
      fs.cpSync(path.join(base, 'modules/sample', name), path.join(root, 'vendor/sample', name));
    }
    commit(root);
  }
  ok(checkout, 'record-base', 'vendor/sample', 'modules/sample', first, '--base', base);
  ok(archived, 'record-base', 'vendor/sample', 'modules/sample', '--ref', first, '--base-archive', initialArchive);
  assert.equal(record(archived), record(checkout), 'Archive recording retains the same mappings, digests, modes and complete source membership');
  equalEditions();

  write(base, 'modules/sample/index.mjs', 'import {helper} from "./helper.mjs"; export const sample = helper;\n');
  write(base, 'modules/sample/helper.mjs', 'export const helper = 2;\n');
  write(base, 'modules/sample/added.mjs', 'export const added = true;\n');
  write(base, 'modules/sample/tests/added.test.mjs', 'upstream test\n');
  write(base, 'foundation/edition-migrations.json', JSON.stringify({schemaVersion: 1, migrations: [{id: 'unrelated-edit', introduced: first, origin: 'modules/unrelated/index.mjs', guide: 'GUIDE.md', edit: 'Review unrelated edit.', deliver: []}]}));
  fs.rmSync(path.join(base, 'modules/sample/data.bin'));
  const next = commit(base), incoming = archive(next, 'incoming-archive');
  const legacy = JSON.parse(record(archived));
  delete legacy.copies[0].originFiles;
  write(archived, 'base-copies.json', JSON.stringify(legacy));
  const beforeLegacy = snapshotTree(archived);
  assert.match(run(archived, 'refresh-base', '--ref', next, '--base-archive', incoming).error, /prior source membership.*--base <checkout>/);
  assert.deepEqual(snapshotTree(archived), beforeLegacy, 'Legacy archive refusal preserves every file and record');
  write(archived, 'base-copies.json', record(checkout));

  const viaCheckout = ok(checkout, 'refresh-base', next, '--base', base);
  const viaArchive = ok(archived, 'refresh-base', '--ref', next, '--base-archive', incoming, '--offline');
  assert.deepEqual(viaArchive, viaCheckout);
  equalEditions();
  assert.equal(fs.existsSync(path.join(archived, 'vendor/sample/omitted.mjs')), false, 'A preexisting omission remains omitted');
  assert.equal(fs.existsSync(path.join(archived, 'vendor/sample/tests/added.test.mjs')), false, 'Excluded tests remain excluded');
  assert.equal(fs.existsSync(path.join(archived, 'vendor/sample/data.bin')), false, 'An upstream removal reaches the archive edition');
  assert.equal(fs.readFileSync(path.join(archived, 'vendor/sample/helper.mjs'), 'utf8'), fs.readFileSync(path.join(base, 'modules/sample/helper.mjs'), 'utf8'));
  ok(archived, 'verify-base', '--offline');
  const repeated = snapshotTree(archived);
  ok(archived, 'refresh-base', next, '--base-archive', incoming);
  assert.deepEqual(snapshotTree(archived), repeated, 'Repeating archive refresh is stable');

  for (const flags of [
    ['--ref', next, '--base', base, '--base-archive', incoming],
    ['--ref', next, '--base-archive', base],
    ['--ref', 'main', '--base-archive', incoming],
    ['--ref', '--base-archive', incoming],
  ]) {
    const refused = run(archived, 'refresh-base', ...flags);
    assert.notEqual(refused.status, 0, refused.error);
    assert.deepEqual(snapshotTree(archived), repeated);
  }
  fs.symlinkSync(path.join(base, 'modules/sample/index.mjs'), path.join(incoming, 'linked.mjs'));
  assert.match(run(archived, 'refresh-base', '--ref', next, '--base-archive', incoming).error, /Unsupported Base archive entry/);
  assert.deepEqual(snapshotTree(archived), repeated);
  fs.rmSync(path.join(incoming, 'linked.mjs'));

  // Matching old workflow bytes and migration introductions require history,
  // which an archive must never invent from its caller-supplied revision.
  write(base, 'export/verify.yml', 'jobs: {}\n');
  commit(base);
  write(base, 'export/verify.yml', 'name: Verify\njobs: {}\n');
  const withWorkflow = commit(base), workflowArchive = archive(withWorkflow, 'workflow-archive');
  write(archived, '.github/workflows/verify.yml', 'jobs: {}\n');
  git(archived, 'add', '.github/workflows/verify.yml');
  const beforeHistory = snapshotTree(archived);
  assert.match(run(archived, 'refresh-base', '--ref', withWorkflow, '--base-archive', workflowArchive).error, /archive has no Git history.*--base <checkout>/);
  assert.deepEqual(snapshotTree(archived), beforeHistory);
  fs.rmSync(path.join(archived, '.github/workflows/verify.yml'));
  git(archived, 'reset', '--quiet', '--', '.github/workflows/verify.yml');
  write(base, 'foundation/edition-migrations.json', JSON.stringify({schemaVersion: 1, migrations: [{id: 'sample-edit', introduced: first, origin: 'modules/sample/index.mjs', guide: 'GUIDE.md', edit: 'Review sample edit.', deliver: []}]}));
  const withMigration = commit(base), migrationArchive = archive(withMigration, 'migration-archive');
  const beforeMigration = snapshotTree(archived);
  assert.match(run(archived, 'refresh-base', '--ref', withMigration, '--base-archive', migrationArchive).error, /archive has no Git history/);
  assert.deepEqual(snapshotTree(archived), beforeMigration);
}
