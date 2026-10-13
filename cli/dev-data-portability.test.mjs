import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { archiveRecords, archiveRows, archiveItems, remakeArchive } from './fixtures/archive-records.mjs';
import { withArchivePolicy, policyArchive, importPolicyArchive } from './fixtures/archive-policy.mjs';

test('default-seed moves exclude authentication identities; explicit inclusion still refuses dev sessions', { timeout: 10 * 60_000 }, async t => {
 const source = await portabilityFixture(t, { generated: false }), target = await portabilityFixture(t, { generated: false });

 await source.run(['export', '--output', 'exports/empty.rer']);
 await source.data(`INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('owner','owner@example.test','Owner','owner','active',1),('persona','admin@dev.localhost','Dev admin','admin','active',2);
  INSERT INTO oa_tokens(id,token_hash,kind,operator_id,operator_version,return_to,created_at,expires_at) VALUES('kept-link','h1','magic','owner',1,'/app',1,2),('dev-link','h2','magic','persona',1,'/app',1,2);
  INSERT INTO oa_dev_credentials(credential,id,created_at) VALUES('oa_tokens','dev-link',1);
  INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at) VALUES('native-session','s1','owner',1,'native',1,4102444800000),('dev-session','s2','owner',1,'dev',1,4102444800000),('persona-session','s3','persona',1,'dev',1,4102444800000);`);
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
