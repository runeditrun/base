import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { parseJsonc } from './jsonc.mjs';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import {createServer} from 'node:net';
import {localOperation} from '../onboarding/local/operation.mjs';
import { createHash } from 'node:crypto';

const stagingTables = async seed => (await seed.data("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'rer_portability_stage_*' ORDER BY name"))[0].results;
const manifest = async (seed, file) => JSON.parse((await readFile(join(seed.root, file), 'utf8')).split('\n')[0]);

test('rer export --target remote runs only a declared checkout script and preserves its outcome', { timeout: 5 * 60_000 }, async t => {
 const seed = await portabilityFixture(t), adapterPath = join(seed.root, 'scripts/installer/local.mjs');
 const adapter = await readFile(adapterPath, 'utf8');
 // An undeclared seed keeps its existing public refusal, before writing anything.
 await seed.text(['export', '--target', 'remote', '--output', 'exports/h.rer'], 2);
 await assert.rejects(stat(join(seed.root, 'exports/h.rer')), { code: 'ENOENT' });
 await writeFile(join(seed.root, 'scripts/hosted-export.mjs'), `
import { mkdir, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2), output = args[args.indexOf('--out') + 1];
if (args.includes('--directory')) await mkdir(output);
await writeFile(args.includes('--directory') ? output + '/manifest.json' : output, JSON.stringify({ args, cwd: process.cwd() }));
console.log('Hosted data saved');
console.error('Hosted export progress');
if (args.includes('--fail')) process.exit(7);
`);
 const declare = value => writeFile(adapterPath, adapter + '\ncommandAdapter.portability.hostedExport = ' + JSON.stringify(value) + ';\n');
 await declare(['node', 'scripts/hosted-export.mjs']);
 const shown = await seed.text(['export', '--target', 'remote', '--output', 'exports/h.rer', '--origin', 'https://hosted.example.test']);
 const saved = JSON.parse(await readFile(join(seed.root, 'exports/h.rer'), 'utf8'));
 assert.deepEqual(saved.args, ['--remote', '--environment', 'production', '--out', 'exports/h.rer', '--origin', 'https://hosted.example.test']);
 assert.equal(saved.cwd, await realpath(seed.root));
 assert.match(shown.stderr, /Hosted data saved[^]*Hosted export progress|Hosted export progress[^]*Hosted data saved/);
 assert.match(shown.stdout, /Exported the hosted install at https:\/\/hosted\.example\.test to exports\/h\.rer .*exit 0/);
 const checked = (await seed.run(['check'])).at(-1);
 assert.ok(checked.clauses.find(row => row.id === 'SC-08.hosted-export')?.ok);
 // Plain export still uses the local portability implementation with the hook declared.
 const local = (await seed.run(['export', '--output', 'exports/local.rer'])).at(-1);
 assert.equal(local.target, 'local');
 assert.ok(local.contentHash);
 const implicit = (await seed.run(['export', '--target', 'remote'])).at(-1);
 assert.equal(implicit.target, 'remote');
 assert.ok((await stat(join(seed.root, implicit.output))).isFile());
 await declare(['node', 'scripts/hosted-export.mjs', '--directory']);
 const directory = (await seed.run(['export', '--target', 'remote', '--output', 'exports/native'])).at(-1);
 assert.equal(directory.output, 'exports/native');
 assert.ok((await stat(join(seed.root, directory.output, 'manifest.json'))).isFile());
 await declare(['node', 'scripts/hosted-export.mjs', '--fail']);
 const failed = await seed.text(['export', '--target', 'remote', '--output', 'exports/failed.rer'], 7);
 assert.match(failed.stdout, /hosted install[^]*exports\/failed\.rer[^]*exit 7/);
 // Invalid argv and script paths fail conformance and execution before a child can write.
 await writeFile(join(seed.root, '../outside.mjs'), "import { writeFile } from 'node:fs/promises'; await writeFile('exports/escaped', 'ran');\n");
 await symlink(join(seed.root, '../outside.mjs'), join(seed.root, 'scripts/linked-export.mjs'));
 for (const value of [['node', '../outside.mjs'], ['node', join(seed.root, 'scripts/hosted-export.mjs')], ['node', 'scripts/linked-export.mjs'], 'node scripts/hosted-export.mjs']) {
  await declare(value);
  const invalid = (await seed.run(['check'], 1)).at(-1);
  assert.equal(invalid.clauses.find(row => row.id === 'SC-08.hosted-export')?.ok, false);
  await seed.text(['export', '--target', 'remote', '--output', 'exports/refused.rer'], 4);
  await assert.rejects(stat(join(seed.root, 'exports/refused.rer')), { code: 'ENOENT' });
  await assert.rejects(stat(join(seed.root, 'exports/escaped')), { code: 'ENOENT' });
 }
});

test('import requires an explicit remote target for a non-local origin and leaves the checkout untouched', { timeout: 10 * 60_000 }, async t => {
 const seed = await portabilityFixture(t);
 await seed.run(['export', '--output', 'exports/empty.rer']);
 await seed.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('backup',3,125,'Saved invoice')");
 await seed.run(['export', '--output', 'exports/saved.rer']);
 await seed.run(['reset', '--yes']);
 await seed.run(['export', '--output', 'exports/destination.rer']);
 // A configured port, rather than the default, determines which loopback origins are local.
 await writeFile(join(seed.root, '.dev.vars'), 'AUTH_ORIGIN=http://127.0.0.1:18987\n', { mode: 0o600 });
 const snapshot = async () => {
  const hashes = {};
  for (const name of (await readdir(seed.root, { recursive: true })).sort()) {
   if (!['.wrangler/', '.seed/', '.rer/', '.dev.vars'].some(prefix => name.startsWith(prefix))) continue;
   const path = join(seed.root, name);
   if ((await stat(path)).isFile()) hashes[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return hashes;
 };
 const before = await snapshot();
 for (const origin of ['https://example.invalid', 'http://example.invalid:18987', 'https://localhost:18987', 'http://127.0.0.1:8787', 'http://localhost:18988', 'http://[::1]:18988', 'http://other.localhost:18987']) {
  for (const target of [[], ['--target', 'local']]) {
   const args = ['import', '--origin', origin, ...target, '--input', 'exports/saved.rer', '--yes'];
   const plain = await seed.text(args, 4);
   assert.equal(plain.stdout, '');
   assert.equal(plain.stderr.trimEnd().split('\n').length, 1);
   assert.ok(plain.stderr.includes(new URL(origin).origin));
   assert.match(plain.stderr, /--target remote/);
   const events = await seed.run(args, 4);
   assert.deepEqual(events.map(row => row.event), ['error', 'result']);
   assert.equal(events[0].message, plain.stderr.trimEnd());
   assert.equal(events[1].ok, false);
   assert.deepEqual(await snapshot(), before, 'refusal must not touch local data, settings or lifecycle state');
  }
 }
 // Even missing archive/session/journal files are not inspected before the origin refusal.
 const missing = await seed.run(['import', '--origin', 'https://example.invalid', '--input', 'missing.rer', '--session-file', 'missing.session', '--journal', 'missing-journal.rer', '--yes'], 4);
 assert.match(missing[0].message, /--target remote/);
 assert.deepEqual(await snapshot(), before);
 assert.equal((await seed.data('SELECT COUNT(*) AS count FROM computed_entries'))[0].results[0].count, 0);
 // An explicitly remote request still reaches the existing adapter capability refusal.
 const remote = await seed.run(['import', '--origin', 'https://example.invalid', '--target', 'remote', '--input', 'exports/saved.rer', '--yes'], 4);
 assert.match(remote.find(row => row.event === 'error').message, /Complete remote import is unsupported/);
 // All direct loopback spellings at the configured port, and an omitted origin, still restore.
 for (const origin of ['http://127.0.0.1:18987', 'http://localhost:18987', 'http://[::1]:18987', undefined]) {
  await seed.run(['reset', '--yes']);
  await writeFile(join(seed.root, '.dev.vars'), 'AUTH_ORIGIN=http://127.0.0.1:18987\n', { mode: 0o600 });
  await seed.run(['import', ...(origin ? ['--origin', origin] : []), '--input', 'exports/saved.rer', '--yes']);
  assert.deepEqual((await seed.data('SELECT id, label FROM computed_entries'))[0].results, [{ id: 'backup', label: 'Saved invoice' }]);
 }
});

// The documented recovery path: export, reset, import the very file that export
// produced, and export again. The same file must always be accepted in place.
test('a file rer just exported imports in place after reset, repeatedly; shared or group-readable input is still refused', { timeout: 15 * 60_000 }, async t => {
 const seed = await portabilityFixture(t);
 // The app's Durable Object binding, as HappyToHelp declares one: the transfer never needs it.
 const wrangler = join(seed.root, 'wrangler.jsonc');
 await writeFile(wrangler, JSON.stringify({ ...parseJsonc(await readFile(wrangler, 'utf8')), durable_objects: { bindings: [{ name: 'CONVERSATIONS', class_name: 'ConversationSocket' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['ConversationSocket'] }] }, null, 2));
 await seed.run(['export', '--output', 'exports/empty.rer']);
 await seed.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('first',3,125,'café'),('second',2,75,NULL)");
 // A person's export prints no workerd warning and no receipt, and ends with one line naming the archive.
 const shown = await seed.text(['export', '--output', 'exports/shown.rer']);
 assert.doesNotMatch(shown.stdout + shown.stderr, /DurableObjectNamespace|ConversationSocket|contentHash|"tables"/);
 const receipt = (await seed.run(['export', '--output', 'exports/shown-data.rer'])).at(-1);
 const rowCount = receipt.tables.reduce((sum, table) => sum + table.count, 0);
 assert.ok(receipt.contentHash && rowCount >= 2, 'the receipt stays --json data');
 assert.match(shown.stdout.trimEnd().split('\n').at(-1), new RegExp(`^Exported the local copy to exports/shown\\.rer \\(\\d+(\\.\\d)? (B|KB|MB)\\): ${receipt.tables.length} tables, ${rowCount.toLocaleString('en-US')} rows$`));
 // A hosted address is refused before any effect, naming the command that exports it, never answered with this computer's copy.
 const hosted = await seed.text(['export', '--origin', 'https://example.invalid', '--output', 'exports/hosted.rer'], 2);
 assert.match(hosted.stderr, /https:\/\/example\.invalid[^]*npx wrangler d1 export \S+ --remote --output /);
 await assert.rejects(stat(join(seed.root, 'exports/hosted.rer')), { code: 'ENOENT' });
 const query = 'SELECT * FROM computed_entries ORDER BY id', rows = (await seed.data(query))[0].results;
 let previous, excludedTables;
 for (const round of [1, 2, 3]) {
  const name = `exports/round-${round}.rer`, exported = (await seed.run(['export', '--output', name])).at(-1);
  const current = await manifest(seed, name);
  if (excludedTables) assert.deepEqual(current.excludedTables, excludedTables, 'restore scratch never enters the next export manifest');
  else excludedTables = current.excludedTables;
  const status = await stat(join(seed.root, name));
  assert.equal(status.nlink, 1, 'export leaves one link to the archive');
  assert.equal(status.mode & 0o777, 0o600);
  await assert.rejects(stat(join(seed.root, `${name}.partial`)), { code: 'ENOENT' });
  if (previous) assert.equal(exported.contentHash, previous, 'the restored installation exports the same data');
  previous = exported.contentHash;
  await seed.run(['reset', '--yes']);
  assert.equal((await seed.run(['import', '--input', name, '--yes'])).at(-1).contentHash, exported.contentHash);
  assert.deepEqual(await stagingTables(seed), [], 'a completed import drops every staging copy and sidecar');
  assert.deepEqual((await seed.data(query))[0].results, rows);
 }
 const after = (await seed.run(['export', '--output', 'exports/after.rer'])).at(-1);
 assert.equal(after.contentHash, previous);
 assert.deepEqual((await manifest(seed, 'exports/after.rer')).excludedTables, excludedTables);
 // This refusal happens after staging, while the existing owner rows stay intact.
 await seed.run(['import', '--input', 'exports/round-1.rer', '--yes'], 4);
 assert.deepEqual(await stagingTables(seed), [], 'a refused import drops its staging after rollback');
 assert.deepEqual((await seed.data(query))[0].results, rows);
 // Negative controls: the check for a private, single-link input stays strict.
 await seed.run(['reset', '--yes']);
 await copyFile(join(seed.root, 'exports/round-1.rer'), join(seed.root, 'shared.rer'));
 await chmod(join(seed.root, 'shared.rer'), 0o600);
 await link(join(seed.root, 'shared.rer'), join(seed.root, 'shared.rer.partial'));
 await seed.run(['import', '--input', 'shared.rer', '--yes'], 4);
 await copyFile(join(seed.root, 'exports/round-1.rer'), join(seed.root, 'group.rer'));
 await chmod(join(seed.root, 'group.rer'), 0o640);
 await seed.run(['import', '--input', 'group.rer', '--yes'], 4);
 const corrupt = await readFile(join(seed.root, 'exports/round-1.rer'), 'utf8');
 await writeFile(join(seed.root, 'corrupt.rer'), corrupt.replace('café', 'changed'), { mode: 0o600 });
 await seed.run(['import', '--input', 'corrupt.rer', '--yes'], 1);
 assert.deepEqual(await stagingTables(seed), [], 'a corrupt archive leaves no staging');
});

test('local import and setup after import finish with a slow inspection and retain restored data', {timeout:10*60_000}, async t=>{
 const seed=await portabilityFixture(t,{generated:false}),slow={slow:true};
 await seed.run(['export','--output','exports/empty.rer']);
 await seed.data("INSERT INTO articles VALUES('retained','retained','Restored title','Owner content','2026-10-16')");
 const saved=(await seed.run(['export','--output','exports/saved.rer'])).at(-1);
 await seed.run(['reset','--yes'],0,slow);
 // An empty, migrated destination still has state files for the injected
 // lsof timeout; importing into absent state would skip that query entirely.
 await seed.run(['export','--output','exports/destination-empty.rer']);
 const operation=await localOperation(seed.root);
 try{
  for(const args of [['import','--input','exports/saved.rer','--yes'],['setup','--owner-email','restored@example.test','--non-interactive']]){
   const refused=await seed.run(args,4,slow);
   assert.match(refused.find(row=>row.event==='error').message,new RegExp(`PID ${process.pid}`));
  }
 }finally{await operation.release();}
 await seed.run(['import','--input','exports/saved.rer','--yes'],0,slow);
 assert.deepEqual(await stagingTables(seed), []);
 const restored=(await seed.run(['export','--output','exports/restored.rer'])).at(-1);
 assert.equal(restored.contentHash,saved.contentHash);
 assert.deepEqual((await manifest(seed,'exports/restored.rer')).excludedTables,(await manifest(seed,'exports/saved.rer')).excludedTables);
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const setup=await seed.run(['setup','--owner-email','restored@example.test','--port',String(port),'--non-interactive'],0,slow);
 assert.ok(setup.some(row=>row.event==='setup-ready'));
 assert.deepEqual((await seed.data("SELECT title,body FROM articles WHERE id='retained'"))[0].results,[{title:'Restored title',body:'Owner content'}]);
 assert.deepEqual((await seed.data("SELECT email FROM oa_operators WHERE role='owner' AND status='active'"))[0].results,[{email:'restored@example.test'}]);
});

// A large install takes many minutes; the person sees lines for it instead of silence, a restore that
// died part-way is cleaned up at the next import, and an unexpected failure names its class and the way on.
test('export and import print progress; a crashed import is cleaned at the next start; a native error names its class, never its data', { timeout: 20 * 60_000 }, async t => {
 const seed = await portabilityFixture(t), query = 'SELECT * FROM computed_entries ORDER BY id';
 await seed.run(['export', '--output', 'exports/empty.rer']);
 // A part holds at most 1,000 rows: this archive has several parts.
 await seed.data("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) INSERT INTO computed_entries(id,quantity,unit_price,label) SELECT 'row' || i, i, 2, NULL FROM n");
 const rows = (await seed.data(query))[0].results;
 const exported = await seed.text(['export', '--output', 'exports/large.rer']);
 assert.match(exported.stderr, /Exporting about [\d.]+ [KMG]?B of local data\./);
 assert.match(exported.stderr, /Building the archive: (\d+) of \1 parts/);
 assert.match(exported.stderr, /Writing the archive: (\d+) of \1 parts \([\d.]+ [KMG]?B\)/);
 assert.ok(Number(/Writing the archive: \d+ of (\d+) parts/.exec(exported.stderr)[1]) >= 3, 'the archive has several parts');
 await seed.run(['reset', '--yes']);
 // The restore process dies once a part is staged (as a crashed worker or workerd does): the person is told, and the staging stays.
 const crashed = await seed.text(['import', '--input', 'exports/large.rer', '--yes'], 1, { fault: 'crash' });
 assert.match(crashed.stderr, /Restoring a [\d.]+ [KMG]?B archive\./);
 assert.match(crashed.stderr, /ended before it finished \(signal SIGKILL\)\. Run the same command again; it starts over/);
 // The unfinished imports and the staging tables belonging to one import job.
 const unfinished = "SELECT (SELECT import_job FROM rer_portability_state) AS job, (SELECT COUNT(*) FROM rer_portability_jobs WHERE kind = 'import' AND phase NOT IN ('complete', 'aborted')) AS unfinished";
 const tablesOf = async job => (await seed.data(`SELECT COUNT(*) AS n FROM sqlite_master WHERE instr(name, 'rer_portability_stage_${job.replaceAll('-', '')}') = 1`))[0].results[0].n;
 const left = (await seed.data(unfinished))[0].results[0];
 assert.ok(left.job && left.unfinished === 1 && await tablesOf(left.job) > 0, 'the crashed import left its staging');
 // The same command again cleans it, says so, shows progress and restores the data.
 const again = await seed.text(['import', '--input', 'exports/large.rer', '--yes']);
 assert.match(again.stderr, /cleaned up an unfinished earlier import/i);
 assert.match(again.stderr, /Staging the restore: (\d+) of \1 parts/);
 assert.match(again.stderr, /All \d+ parts are staged/);
 assert.deepEqual((await seed.data(query))[0].results, rows);
 assert.deepEqual((await seed.data(unfinished))[0].results[0], { job: null, unfinished: 0 });
 assert.equal(await tablesOf(left.job), 0, 'the crashed import\'s staging is gone');
 assert.deepEqual(await stagingTables(seed), [], 'the replacement import also drops its own staging');
 // An unexpected failure names its class, never its message, and the staging it made is aborted.
 await seed.run(['reset', '--yes']);
 const native = await seed.text(['import', '--input', 'exports/large.rer', '--yes'], 1, { fault: 'native' });
 assert.match(native.stderr, /\(native_error: RangeError\)\. Run the same command again; it starts over\./);
 assert.doesNotMatch(native.stdout + native.stderr, /private row content/);
 assert.deepEqual((await seed.data(unfinished))[0].results[0], { job: null, unfinished: 0 });
 assert.deepEqual(await stagingTables(seed), [], 'a failed import drops its staging');
});
