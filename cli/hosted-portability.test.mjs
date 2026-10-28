import '../modules/container/adapters/d1-workerd-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from '../modules/portability/tests/runtime.mjs';
import { portabilityFixture } from './fixtures/portability.mjs';
import { archiveRecords, remakeArchive } from './fixtures/archive-records.mjs';

test('rer hosted export restores locally across DDL formatting, cleans snapshots, and refuses changed definitions', { timeout: 180_000 }, async t => {
 const target = await portabilityFixture(t, { generated: false });
 const directory = join(target.root, 'migrations/core');
 await rm(directory, { recursive: true }); await mkdir(directory);
 const sql = `CREATE TABLE invoices (
 id TEXT PRIMARY KEY,
 -- Hosted D1 preserves comments; the local migration splitter removes them.
 quantity INTEGER NOT NULL,
 /* Tax remains a computed value. */
 total INTEGER AS (quantity * 125) STORED,
 label TEXT DEFAULT '-- keep /* literal */  spaces',
 "/* quoted column */" TEXT CHECK (quantity >= 0)
 )`;
 await writeFile(join(directory, '0001_invoices.sql'), sql.replace('quantity * 125', 'quantity*125').replace('id TEXT PRIMARY KEY', 'id  TEXT\nPRIMARY KEY') + ';');
 const adapter = join(target.root, 'scripts/installer/local.mjs');
 const original = await readFile(adapter, 'utf8');
 await writeFile(adapter, original.replace('policy: portabilityPolicy', "policy: { product: 'synthetic-hosted-portability' }") +
  '\ncommandAdapter.portability.hostedExport = ' + JSON.stringify(['node', 'scripts/hosted-export.mjs']) + ';\n');
 // Hosted hooks must be checkout scripts. This wrapper invokes the maintained client.
 await writeFile(join(target.root, 'scripts/hosted-export.mjs'), `import { main } from ${JSON.stringify(new URL('../modules/portability/cli.mjs', import.meta.url).href)};
const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
await main(['export','--origin',get('--origin'),'--session-file',new URL('../session.cookie',import.meta.url).pathname,'--out',new URL('../'+get('--out'),import.meta.url).pathname]);`);
 const script = (await build({ entryPoints: [new URL('./fixtures/hosted-portability-worker.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text;
 const cookie = 'session=synthetic-hosted-portability';
 const mf = new Miniflare({ ...convertV4MiniflareOptions({ cf: false, modules: true, script, compatibilityDate: '2026-09-01', d1Databases: { DB: 'hosted' }, bindings: { TEST_COOKIE: cookie } }), resourcePersistencePath: join(target.root, 'hosted-state') });
 t.after(() => mf.dispose());
 const db = await mf.getD1Database('DB');
 const schema = await readFile(new URL('../modules/portability/schema/portability.sql', import.meta.url), 'utf8');
 await db.batch([...schema.split(';').map(s => s.trim()).filter(Boolean), sql,
  'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)', "INSERT INTO d1_migrations VALUES(1,'0001_invoices.sql','2026-10-23')",
  "INSERT INTO invoices(id,quantity) VALUES('synthetic-invoice-1',3)"].map(s => db.prepare(s)));
 await writeFile(join(target.root, 'session.cookie'), cookie, { mode: 0o600 });
 const origin = (await mf.ready).origin;
 const exported = await target.text(['export', '--target', 'remote', '--origin', origin, '--output', 'exports/hosted.rer']);
 console.log('hosted export:', exported.stdout.trim());
 const snapshots = (await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name GLOB 'rer_portability_snap_*'").first()).n;
 console.log('snapshot tables after download:', snapshots);
 const input = ['import', '--input', 'exports/hosted.rer', '--yes'];
 // Print the original public result before asserting, preserving the failing case.
 const imported = await target.text(input);
 console.log('same-revision import:', imported.stdout.trim());
 assert.equal(snapshots, 0);
 assert.deepEqual((await target.data('SELECT id,quantity,total,label FROM invoices'))[0].results,
  [{ id: 'synthetic-invoice-1', quantity: 3, total: 375, label: '-- keep /* literal */  spaces' }]);
 const records = archiveRecords(await readFile(join(target.root, 'exports/hosted.rer'), 'utf8'));
 assert.ok(records[0].tables[0].sql.includes('-- Hosted D1'));
 // Existing raw-DDL archives still verify and restore under the normalized identity.
 await target.run(['reset', '--yes']);
 await writeFile(join(target.root, 'exports/legacy.rer'), (await remakeArchive(records)).map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
 await target.run(['import', '--input', 'exports/legacy.rer', '--yes']);
 await target.run(['reset', '--yes']);
 // Same column inventory, genuinely different CHECK, expression or string default.
 for (const changed of [sql.replace('>= 0', '> 0'), sql.replace('* 125', '+ 125'), sql.replace('literal */  spaces', 'literal */ spaces')]) {
  await writeFile(join(directory, '0001_invoices.sql'), changed + ';');
  const refused = await target.text(input, 4);
  console.log('different definition:', refused.stderr.trim());
  assert.match(refused.stderr, /schema_mismatch/);
  assert.equal((await target.data('SELECT COUNT(*) n FROM invoices'))[0].results[0].n, 0);
  await target.run(['reset', '--yes']);
 }
});
