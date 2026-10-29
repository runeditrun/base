import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

export async function archiveDeliveryJourney(t, {fixture, write, commit, git}) {
 await t.test('archive without Base Git history', async () => {
  const {seed, source, result, old, run} = await fixture(t);
  write(source, 'export/verify.yml', 'jobs: {}\n');
  commit(source);
  write(seed, '.github/workflows/verify.yml', 'jobs: {}\n');
  commit(seed);
  write(source, 'export/verify.yml', 'name: Verify\njobs: {}\n');
  const pin = commit(source), archive = path.join(path.dirname(source), 'archive');
  fs.mkdirSync(archive);
  execFileSync('tar', ['-xf', '-', '-C', archive], {input: execFileSync('git', ['-C', source, 'archive', pin])});
  const before = fs.readFileSync(path.join(seed, '.github/workflows/verify.yml'));
  const refreshed = result('refresh-base', '--ref', pin, '--base-archive', archive);
  assert.deepEqual(fs.readFileSync(path.join(seed, '.github/workflows/verify.yml')), before);
  assert.equal(refreshed.templateAdoptions.length, 0);
  assert.ok(refreshed.notices.some(notice => notice.includes('.github/workflows/verify.yml')));
  old('verify-base', '--offline');
  // Explicitly recorded templates still update, with no history to infer.
  fs.copyFileSync(path.join(archive, 'export/verify.yml'), path.join(seed, '.github/workflows/verify.yml'));
  old('record-base', '.github/workflows/verify.yml', 'export/verify.yml', '--ref', pin, '--base-archive', archive);
  result('refresh-base', '--ref', pin, '--base-archive', archive);
  write(seed, '.github/workflows/verify.yml', 'owner edit\n');
  assert.notEqual(run('refresh-base', '--ref', pin, '--base-archive', archive).status, 0, 'recorded owner edits still refuse');
  console.log('Archive refresh exit=0; unrecorded workflow preserved; recorded edit refused');
 });
 await t.test('delivered tool and package share locks and parser notices', async () => {
  const {seed, source, old, result, pkg, env} = await fixture(t);
  fs.cpSync(path.join(pkg, 'edition-authoring'), path.join(source, 'edition-authoring'), {recursive: true});
  write(source, 'export/verify.yml', 'jobs:\n  check:\n    steps:\n      - run: node scripts/edition-authoring/cli.mjs check\n');
  const pin = commit(source);
  write(seed, '.github/workflows/verify.yml', fs.readFileSync(path.join(source, 'export/verify.yml')));
  old('record-base', '.github/workflows/verify.yml', 'export/verify.yml', pin, '--base', source);
  commit(seed);
  result('refresh-base', '--ref', pin, '--base', source);
  result('adopt-edition');
  git(seed, 'add', '-A');
  old('lock');
  const delivered = spawnSync(process.execPath, ['scripts/edition-authoring/cli.mjs', 'check'], {cwd: seed, env, encoding: 'utf8'});
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  for (const parser of ['yaml', 'babel-parser']) for (const name of ['LICENSE', 'README.md']) {
   assert.deepEqual(fs.readFileSync(path.join(seed, 'scripts/edition-authoring/vendor', parser, name)), fs.readFileSync(path.join(pkg, 'edition-authoring/vendor', parser, name)));
  }
  const locked = spawnSync(process.execPath, ['scripts/edition-authoring/cli.mjs', 'lock'], {cwd: seed, env, encoding: 'utf8'});
  assert.equal(locked.status, 0, locked.stderr);
  old('check');
  console.log('Delivered/package locks: check exit=0 in both directions; yaml/Babel LICENSE and README equal');
 });
}
