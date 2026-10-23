import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { archiveRecords, remakeArchive } from './fixtures/archive-records.mjs';
import { canonicalJson, sha256 } from '../modules/portability/hash.mjs';
import { schemaSQL } from '../modules/portability/schema-identity.mjs';

const tables = `CREATE TABLE invoices(id TEXT PRIMARY KEY,quantity INTEGER CHECK(quantity >= 7),
 label TEXT DEFAULT 'keep -- /* alpha */',total INTEGER AS (quantity * 125) STORED);
CREATE TABLE audit(message TEXT);`;
const objects = `CREATE UNIQUE INDEX invoice_quantity ON invoices(quantity);
CREATE VIEW invoice_totals AS SELECT quantity+1 AS next FROM invoices;
CREATE TRIGGER invoice_added AFTER INSERT ON invoices BEGIN INSERT INTO audit VALUES('alpha'); END;`;

test('CLI restore checks behavioral schema objects and authenticates older schema identities', { timeout: 600_000 }, async t => {
 const f = await portabilityFixture(t, { generated: false });
 const directory = join(f.root, 'migrations/core');
 await rm(directory, { recursive: true }); await mkdir(directory);
 const migration = join(directory, '0001_invoices.sql'), sql = tables + objects;
 await writeFile(migration, sql);
 const adapter = join(f.root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('policy: portabilityPolicy', "policy: { product: 'schema-portability' }"));
 await f.run(['export', '--output', 'exports/empty.rer']);
 await f.data("INSERT INTO invoices(id,quantity) VALUES('invoice-2026-1042',8)");
 await f.run(['export', '--output', 'exports/saved.rer']);
 const saved = archiveRecords(await readFile(join(f.root, 'exports/saved.rer'), 'utf8'));
 const input = path => ['import', '--input', path, '--yes'];
 const checkRows = async () => {
  assert.deepEqual((await f.data('SELECT * FROM invoices'))[0].results,
   [{ id: 'invoice-2026-1042', quantity: 8, label: 'keep -- /* alpha */', total: 1000 }]);
  assert.deepEqual((await f.data('SELECT * FROM audit'))[0].results, [{ message: 'alpha' }]);
 };
 const variants = [
  ['trigger body', sql.replace("VALUES('alpha')", "VALUES('beta')")],
  ['view body', sql.replace('quantity+1', 'quantity+2')],
  ['unique index', sql.replace('CREATE UNIQUE INDEX', 'CREATE INDEX')],
  ['CHECK', sql.replace('>= 7', '> 7')],
  ['quoted default', sql.replace('keep -- /* alpha */', 'keep -- /* beta */')],
  ['generated column', sql.replace('quantity * 125', 'quantity + 125')],
 ];
 for (const [name, changed] of variants) await t.test(name, async () => {
  await f.run(['reset', '--yes']); await writeFile(migration, changed);
  const result = await f.text(input('exports/saved.rer'), 4);
  console.log(name + ':', result.stderr.trim());
  assert.match(result.stderr, /schema_mismatch/);
  assert.equal((await f.data('SELECT COUNT(*) n FROM invoices'))[0].results[0].n, 0);
 });
 await t.test('comments and whitespace in every object', async () => {
  await f.run(['reset', '--yes']);
  await writeFile(migration, sql.replace('quantity * 125', 'quantity*125').replace('quantity+1', 'quantity + /* next */ 1')
   .replace('ON invoices(quantity)', 'ON invoices ( quantity )').replace('BEGIN INSERT', 'BEGIN /* audit */\n INSERT'));
  console.log('equivalent schema:', (await f.text(input('exports/saved.rer'))).stdout.trim());
  await checkRows();
 });
 // Older identities may still carry a complete, archiveHash-bound object
 // inventory. Compare it after verifying the original table-only checksum.
 await t.test('old table-only identity with complete definitions', async () => {
  await f.run(['reset', '--yes']); await writeFile(migration, sql);
  await writeFile(join(f.root, 'exports/old-identity.rer'), (await remakeArchive(saved)).map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  await f.text(input('exports/old-identity.rer')); await checkRows();
  const schema = await sha256(canonicalJson(saved[0].tables.map(({name, sql}) => ({name, sql: schemaSQL(sql)}))));
  await writeFile(join(f.root, 'exports/old-normalized.rer'), (await remakeArchive(saved, {schema})).map(JSON.stringify).join('\n') + '\n', {mode: 0o600});
  await f.run(['reset', '--yes']);
  await f.text(input('exports/old-normalized.rer')); await checkRows();
  for (const [name, changed] of variants.slice(0, 3)) {
   await f.run(['reset', '--yes']); await writeFile(migration, changed);
   const result = await f.text(input('exports/old-identity.rer'), 4);
   console.log('old identity ' + name + ':', result.stderr.trim());
   assert.match(result.stderr, /schema_mismatch/);
  }
 });
 await t.test('old archive without definitions refuses unverifiable objects with recovery guidance', async () => {
  const legacy = structuredClone(saved); delete legacy[0].schemaObjects;
  await writeFile(join(f.root, 'exports/legacy.rer'), (await remakeArchive(legacy)).map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  for (const changed of [sql, ...variants.slice(0, 3).map(([, changed]) => changed), tables]) {
   await f.run(['reset', '--yes']); await writeFile(migration, changed);
   const result = await f.text(input('exports/legacy.rer'), 4);
   console.log('missing old definitions:', result.stderr.trim());
   assert.match(result.stderr, /schema_mismatch/);
   assert.match(result.stderr, /rer export --output \S+.*--target remote.*rer import --input/s);
   assert.equal((await f.data('SELECT COUNT(*) n FROM invoices'))[0].results[0].n, 0);
  }
  // The previous tokenized identity also refuses missing evidence, including
  // a destination from which all non-table objects have been removed.
  const schema = await sha256(canonicalJson(legacy[0].tables.map(({name, sql}) => ({name, sql: schemaSQL(sql)}))));
  await writeFile(join(f.root, 'exports/legacy-normalized.rer'), (await remakeArchive(legacy, {schema})).map(JSON.stringify).join('\n') + '\n', {mode: 0o600});
  await f.run(['reset', '--yes']);
  const result = await f.text(input('exports/legacy-normalized.rer'), 4);
  assert.match(result.stderr, /schema_mismatch/);
  assert.match(result.stderr, /rer export --output/);
 });
});
