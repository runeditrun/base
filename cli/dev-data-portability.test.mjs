import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { archiveRecords, archiveRows, archiveItems, remakeArchive } from './fixtures/archive-records.mjs';
import { withArchivePolicy, policyArchive, importPolicyArchive } from './fixtures/archive-policy.mjs';

test('default-seed moves exclude authentication identities; explicit inclusion still refuses dev sessions', { timeout: 10 * 60_000 }, async t => {
 const source = await portabilityFixture(t, { generated: false }), target = await portabilityFixture(t, { generated: false });

 await source.run(['export', '--output', 'exports/empty.rer']);
 for (const f of [source, target]) await writeFile(join(f.root, 'migrations/core/0999_oncall.sql'), 'CREATE TABLE IF NOT EXISTS oc_unlisted(id TEXT PRIMARY KEY, body TEXT);');
 await source.data("CREATE TABLE IF NOT EXISTS oc_unlisted(id TEXT PRIMARY KEY, body TEXT); INSERT INTO oc_unlisted VALUES('retained','Oncall product data')");
 const unlisted = await source.text(['export', '--output', 'exports/unlisted.rer'], 4);
 assert.match(unlisted.stderr, /identity_table_undeclared:oc_unlisted/);
 for (const f of [source, target]) {
  const adapter = join(f.root, 'scripts/installer/local.mjs');
  await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('policy: portabilityPolicy', "policy: { ...portabilityPolicy, includeTables: ['oc_unlisted'] }"));
 }
 console.log('Unnamed oc_ export: exit=4; explicit inclusion restores its product row');

 const identityHashes = Array.from({length: 5}, () => randomBytes(32).toString('hex'));
 await source.data(`INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('owner','owner@example.test','Owner','owner','active',1),('persona','admin@dev.localhost','Dev admin','admin','active',2);
  INSERT INTO oa_tokens(id,token_hash,kind,operator_id,operator_version,return_to,created_at,expires_at) VALUES('kept-link','${identityHashes[0]}','magic','owner',1,'/app',1,2),('dev-link','${identityHashes[1]}','magic','persona',1,'/app',1,2);
  INSERT INTO oa_dev_credentials(credential,id,created_at) VALUES('oa_tokens','dev-link',1);
  INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at) VALUES('native-session','${identityHashes[2]}','owner',1,'native',1,4102444800000),('dev-session','${identityHashes[3]}','owner',1,'dev',1,4102444800000),('persona-session','${identityHashes[4]}','persona',1,'dev',1,4102444800000);`);
 await source.run(['export', '--output', 'exports/identity.rer']);
 const archive = archiveRecords(await readFile(join(source.root, 'exports/identity.rer'), 'utf8'));
 assert.deepEqual(archiveRows(archive, 'oa_sessions'), []);
 assert.deepEqual(archiveRows(archive, 'oa_tokens'), [], 'one-use sign-in tokens do not travel');
 assert.deepEqual(archiveRows(archive, 'oa_dev_credentials'), []);
 assert.deepEqual(archiveRows(archive, 'oa_operators'), [], 'the destination starts with a fresh owner claim');
 await writeFile(join(target.root, 'exports/identity.rer'), await readFile(join(source.root, 'exports/identity.rer')), { mode: 0o600 });
 await target.run(['import', '--input', 'exports/identity.rer', '--yes']);
 assert.deepEqual((await target.data('SELECT id,kind FROM oa_sessions'))[0].results, []);
 assert.deepEqual((await target.data('SELECT * FROM oa_operators ORDER BY id'))[0].results, archiveRows(archive, 'oa_operators'));
 assert.deepEqual((await target.data('SELECT * FROM oa_tokens ORDER BY id'))[0].results, archiveRows(archive, 'oa_tokens'));
 assert.deepEqual((await target.data('SELECT * FROM oc_unlisted'))[0].results, [{id:'retained', body:'Oncall product data'}]);
 await target.run(['reset', '--yes']);
 // The module also supports explicit inclusion. Its mandatory dev-data rule
 // still removes dev rows, then refuses a checksum-valid dev-session import.
 const included = await withArchivePolicy(source, archive[0], policyArchive);
 assert.deepEqual(archiveRows(included, 'oa_operators').map(row => [row.email, row.status, Number(row.version)]), [['owner@example.test', 'active', 1], ['admin@dev.localhost', 'inactive', 2]]);
 assert.deepEqual(archiveRows(included, 'oa_tokens').map(row => row.id), ['kept-link']);
 assert.deepEqual(archiveRows(included, 'oa_sessions').map(row => [row.id, row.kind]), [['native-session', 'native']]);
 assert.deepEqual(archiveRows(included, 'oa_dev_credentials'), []);
 const crafted = await remakeArchive(included, { items: archiveItems(included).map(item => item.table === 'oa_sessions' ? { ...item, row: { ...item.row, kind: 'dev' } } : item) });
 await writeFile(join(target.root, 'dev.rer'), crafted.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
 const refused = await target.run(['import', '--input', 'dev.rer', '--yes'], 4);
 assert.equal(refused.at(-1).exitCode, 4);
 assert.match(refused.find(event => event.event === 'error').message, /schema_mismatch/);
 await withArchivePolicy(target, archive[0], async service => {
  await assert.rejects(importPolicyArchive(service, crafted), error => error.code === 'dev_data:oa_sessions' && error.status === 409);
 });
 const empty = await target.data('SELECT count(*) AS n FROM oa_sessions; SELECT count(*) AS n FROM oa_operators; SELECT count(*) AS n FROM oa_tokens');
 for (const result of empty) assert.deepEqual(result.results, [{ n: 0 }], 'neither refusal restored any identity data');
});
