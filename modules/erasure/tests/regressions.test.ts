import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createErasure, defineErasure } from '../index.mjs';
import { createPortability, sha256, canonicalJson } from '../../portability/index.mjs';
import { archive, restore } from '../../portability/tests/helpers.mjs';
const schema = (await Promise.all(['../../portability/schema/portability.sql', '../schema/erasure.sql'].map(p => readFile(new URL(p, import.meta.url), 'utf8')))).flatMap(s => s.split(';').map(s => s.trim()).filter(Boolean));
async function fixture(t: any, sql: string[], declaration: any) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', compatibilityDate: '2026-09-01', d1Databases: { DB: 'regressions' }, r2Buckets: { FILES: 'regressions' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('FILES');
  await db.batch([...schema, ...sql].map(s => db.prepare(s)));
  const portability = await createPortability({ db, buckets: { FILES: bucket }, policy: { product: 'erasure-proof', excludeTables: ['rer_erasure_blobs', 'rer_erasure_guard', 'rer_erasure_scope'] } });
  const erasure = createErasure({ db, buckets: { FILES: bucket }, portability, declarations: [defineErasure(declaration)] });
  return { db, bucket, erasure, portability };
}
test("erasure graph admission and resumption preserve retained history and fence every erased dependent", async t => {
  const step = namedSteps(t);
  await step('overlapping paths delete each child before its parent and fence its blob row', async t => {
    const { db, bucket, erasure } = await fixture(t, [
      'CREATE TABLE people(id TEXT PRIMARY KEY)',
      'CREATE TABLE folders(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE)',
      'CREATE TABLE files(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE,folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,storage_key TEXT)',
      "INSERT INTO people VALUES('target'),('peer')", "INSERT INTO folders VALUES('folder','target')",
      "INSERT INTO files VALUES('file','target','folder','target-object'),('peer-file','peer',NULL,'peer-object')",
    ], { entity: 'person', root: { table: 'people' }, edges: [
      { table: 'folders', from: 'people', on: { person_id: 'id' } },
      { table: 'files', from: 'people', on: { person_id: 'id' }, blob: { bucket: 'FILES', keyColumn: 'storage_key' } },
      { table: 'files', from: 'folders', on: { folder_id: 'id' } },
    ] });
    await bucket.put('target-object', 'personal bytes'); await bucket.put('peer-object', 'peer bytes');
    const done = await erasure.run((await erasure.start('person', { id: 'target' })).id, { rows: 1 });
    assert.equal(done.phase, 'complete'); assert.equal(done.deleted.files, 1); assert.equal(await bucket.head('target-object'), null);
    assert.equal(await (await bucket.get('peer-object'))!.text(), 'peer bytes');
    assert.deepEqual((await db.prepare('SELECT id FROM files').all()).results, [{ id: 'peer-file' }]);
    const source = (await db.prepare('SELECT source_identity FROM rer_portability_state').first<any>())!.source_identity;
    assert.ok(await db.prepare('SELECT 1 FROM rer_portability_journal WHERE tombstone=?').bind(await sha256(canonicalJson([source, 'files', { id: 'file' }]))).first());
  });
  
  await step('resumption scrubs late audit rows for both newly reached and already deleted dependents', async t => {
    const { db, erasure } = await fixture(t, [
      'CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE notes(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE,body TEXT)',
      'CREATE TABLE audit_events(id TEXT PRIMARY KEY,entity_id TEXT,detail TEXT)',
      "INSERT INTO people VALUES('target'),('peer')", "INSERT INTO notes VALUES('n1','target','first'),('n2','target','second'),('peer-note','peer','kept')",
      "INSERT INTO audit_events VALUES('a1','n1','first'),('peer','peer-note','kept')",
    ], { entity: 'person', root: { table: 'people' }, edges: [{ table: 'notes', from: 'people', on: { person_id: 'id' } }], audit: [{ table: 'audit_events', column: 'entity_id', of: 'notes', clear: { detail: '{}' } }] });
    const opened = await erasure.start('person', { id: 'target' });
    assert.equal((await erasure.commit(opened.id, { rows: 1, until: 0 })).phase, 'deleting');
    await db.batch([db.prepare("INSERT INTO notes VALUES('n3','target','LATE-CANARY')"), db.prepare("INSERT INTO audit_events VALUES('a3','n3','LATE-CANARY'),('late-old','n1','LATE-CANARY')")]);
    const done = await erasure.run(opened.id, { rows: 1 });
    assert.equal(done.phase, 'complete');
    assert.deepEqual((await db.prepare("SELECT entity_id,detail FROM audit_events WHERE id<>'peer'").all()).results, Array(3).fill({ entity_id: done.label, detail: '{}' }));
    assert.deepEqual(await db.prepare("SELECT entity_id,detail FROM audit_events WHERE id='peer'").first(), { entity_id: 'peer-note', detail: 'kept' });
    assert.deepEqual((await db.prepare('SELECT id FROM notes').all()).results, [{ id: 'peer-note' }]);
    // A writer commits after collection, immediately before the intended final batch.
    let announce!: () => void, release!: () => void, once = true;
    const ready = new Promise<void>(resolve => { announce = resolve; });
    const writerFinished = new Promise<void>(resolve => { release = resolve; });
    const raced = await fixture(t, ['CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE notes(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE,body TEXT)', 'CREATE TABLE audit_events(id TEXT PRIMARY KEY,entity_id TEXT,detail TEXT)', "INSERT INTO people VALUES('target')", "INSERT INTO notes VALUES('n1','target','first')"], { entity: 'person', root: { table: 'people' }, edges: [{ table: 'notes', from: 'people', on: { person_id: 'id' } }], audit: [{ table: 'audit_events', column: 'entity_id', of: 'notes', clear: { detail: '{}' } }], beforeStatements: async () => { if (once) { once = false; announce(); await writerFinished; } return []; } });
    const operation = await raced.erasure.start('person', { id: 'target' });
    const finishing = raced.erasure.run(operation.id, { rows: 1 });
    await ready;
    await raced.db.batch([raced.db.prepare("INSERT INTO notes VALUES('n2','target','LAST-MOMENT-CANARY')"), raced.db.prepare("INSERT INTO audit_events VALUES('late','n2','LAST-MOMENT-CANARY')")]);
    release();
    const finished = await finishing;
    assert.equal(finished.phase, 'complete'); assert.equal(finished.deleted.notes, 2);
    assert.deepEqual(await raced.db.prepare('SELECT entity_id,detail FROM audit_events').first(), { entity_id: finished.label, detail: '{}' });
    assert.equal((await raced.db.prepare('SELECT count(*) n FROM notes').first<any>())!.n, 0);
    // D1 is fenced before the public blob phase; writes in that window must also
    // be discovered, erased and fenced before the receipt becomes complete.
    const boundary = await fixture(t, ['CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE notes(id TEXT PRIMARY KEY,person_id TEXT,body TEXT,storage_key TEXT)', 'CREATE TABLE audit_events(id TEXT PRIMARY KEY,entity_id TEXT,detail TEXT)', "INSERT INTO people VALUES('target'),('peer')", "INSERT INTO notes VALUES('n1','target','first','old-object'),('peer-note','peer','kept','peer-object')", "INSERT INTO audit_events VALUES('a1','n1','first'),('peer','peer-note','kept')"], { entity: 'person', root: { table: 'people' }, edges: [{ table: 'notes', from: 'people', on: { person_id: 'id' }, blob: { bucket: 'FILES', keyColumn: 'storage_key' } }], audit: [{ table: 'audit_events', column: 'entity_id', of: 'notes', clear: { detail: '{}' } }] });
    await boundary.bucket.put('old-object', 'first personal bytes'); await boundary.bucket.put('peer-object', 'kept peer bytes');
    const pending = await boundary.erasure.start('person', { id: 'target' });
    assert.equal((await boundary.erasure.commit(pending.id)).phase, 'blobs');
    await boundary.bucket.put('late-object', 'AFTER-D1-CANARY');
    await boundary.db.batch([boundary.db.prepare("INSERT INTO notes VALUES('n2','target','AFTER-D1-CANARY','late-object')"), boundary.db.prepare("INSERT INTO audit_events VALUES('a2','n2','AFTER-D1-CANARY'),('late-old','n1','AFTER-D1-CANARY')"), boundary.db.prepare("UPDATE audit_events SET detail='AFTER-D1-CANARY' WHERE id='a1'")]);
    const completed = await boundary.erasure.deleteBlobs(pending.id);
    assert.equal(completed.phase, 'complete'); assert.equal(completed.deleted.notes, 2);
    assert.deepEqual((await boundary.db.prepare("SELECT entity_id,detail FROM audit_events WHERE id<>'peer'").all()).results, Array(3).fill({ entity_id: completed.label, detail: '{}' }));
    assert.deepEqual((await boundary.db.prepare('SELECT id FROM notes').all()).results, [{ id: 'peer-note' }]);
    assert.equal(await boundary.bucket.head('old-object'), null); assert.equal(await boundary.bucket.head('late-object'), null);
    assert.equal(await (await boundary.bucket.get('peer-object'))!.text(), 'kept peer bytes');
    assert.deepEqual(completed.blobs, { total: 2, deleted: 2 });
    assert.equal((await boundary.db.prepare('SELECT count(*) n FROM rer_erasure_scope').first<any>())!.n, 0);
  });
  
  await step('rer product tables cannot bypass undeclared foreign-key admission', async t => {
    const { db, erasure } = await fixture(t, ['CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE rer_person_invoices(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE)', "INSERT INTO people VALUES('target')", "INSERT INTO rer_person_invoices VALUES('invoice','target')"], { entity: 'person', root: { table: 'people' } });
    for (const method of ['preview', 'start'] as const) await assert.rejects(erasure[method]('person', { id: 'target' }), { code: 'undeclared_dependent:rer_person_invoices:people' });
    assert.ok(await db.prepare("SELECT 1 FROM rer_person_invoices WHERE id='invoice'").first());
    assert.equal((await db.prepare('SELECT count(*) n FROM rer_erasure_operations').first<any>())!.n, 0);
  });
  
  await step('retained exceptions refuse destructive foreign keys before changing any person', async t => {
    const { db, erasure } = await fixture(t, ['CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE opt_outs(hash TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE)', "INSERT INTO people VALUES('target'),('peer')", "INSERT INTO opt_outs VALUES('suppression','target'),('peer-suppression','peer')"], { entity: 'person', root: { table: 'people' }, retain: [{ table: 'opt_outs', reason: 'prevent re-contact' }] });
    for (const method of ['preview', 'start'] as const) await assert.rejects(erasure[method]('person', { id: 'target' }), { code: 'unsafe_retained_fk:opt_outs:people' });
    assert.equal((await db.prepare('SELECT count(*) n FROM people').first<any>())!.n, 2);
    assert.equal((await db.prepare('SELECT count(*) n FROM opt_outs').first<any>())!.n, 2);
    const safe = await fixture(t, ['CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE opt_outs(hash TEXT PRIMARY KEY)', "INSERT INTO people VALUES('target')", "INSERT INTO opt_outs VALUES('suppression')"], { entity: 'person', root: { table: 'people' }, retain: [{ table: 'opt_outs', reason: 'prevent re-contact' }], statements: ({ db }: any) => [db.prepare('DELETE FROM opt_outs')] });
    const opened = await safe.erasure.start('person', { id: 'target' });
    await assert.rejects(safe.erasure.run(opened.id), { code: 'retained_row_missing' });
    assert.ok(await safe.db.prepare("SELECT 1 FROM people WHERE id='target'").first());
    assert.ok(await safe.db.prepare("SELECT 1 FROM opt_outs WHERE hash='suppression'").first());
    assert.equal((await safe.erasure.receipt(opened.id)).phase, 'deleting');
    const boundary = await fixture(t, ['CREATE TABLE people(id TEXT PRIMARY KEY)', 'CREATE TABLE opt_outs(hash TEXT PRIMARY KEY)', "INSERT INTO people VALUES('target')", "INSERT INTO opt_outs VALUES('suppression')"], { entity: 'person', root: { table: 'people' }, retain: [{ table: 'opt_outs', reason: 'prevent re-contact' }] });
    const pending = await boundary.erasure.start('person', { id: 'target' });
    assert.equal((await boundary.erasure.commit(pending.id)).phase, 'blobs');
    await boundary.db.prepare('DELETE FROM opt_outs').run();
    await assert.rejects(boundary.erasure.deleteBlobs(pending.id), { code: 'retained_row_missing' });
    assert.equal((await boundary.erasure.receipt(pending.id)).phase, 'blobs');
    // Restoring the required exception lets the same operation finish.
    await boundary.db.prepare("INSERT INTO opt_outs VALUES('suppression')").run();
    assert.equal((await boundary.erasure.deleteBlobs(pending.id)).phase, 'complete');
  });
  
  await step('a value-free redacted root preserves attribution and fences its pre-erasure row', async t => {
   for (const withChild of [false, true]) {
    const sql = ['CREATE TABLE workspaces(id TEXT PRIMARY KEY)', "INSERT INTO workspaces VALUES('opaque-workspace')", 'CREATE TABLE operators(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),email TEXT UNIQUE,name TEXT,status TEXT)', 'CREATE TABLE sessions(id TEXT PRIMARY KEY,operator_id TEXT REFERENCES operators(id) ON DELETE CASCADE)', "INSERT INTO operators VALUES('target','opaque-workspace','personal@example.test','Personal','removed'),('peer','opaque-workspace','peer@example.test','Peer','active')"];
    if (withChild) sql.push("INSERT INTO sessions VALUES('s','target')");
    const declaration = { entity: 'operator', root: { table: 'operators', redact: { identityColumns: ['workspace_id'], set: ({ anonymousId }: any) => ({ email: anonymousId + '@removed.invalid', name: 'Removed operator', status: 'removed' }), reason: 'stable anonymous attribution' } }, edges: [{ table: 'sessions', from: 'operators', on: { operator_id: 'id' } }] };
    const sourceFixture = await fixture(t, sql, declaration);
    const { db, erasure, portability } = sourceFixture;
    const before = await archive(portability);
    const preview = await erasure.preview('operator', { id: 'target' });
    assert.equal(preview.redacted.operators, 1); assert.equal(preview.deleted.operators, undefined);
    const pending = await erasure.start('operator', { id: 'target' });
    assert.equal((await erasure.commit(pending.id)).phase, 'blobs');
    assert.equal((await erasure.start('operator', { id: 'target' })).id, pending.id);
    await db.batch([db.prepare("UPDATE operators SET email='LATE-PERSONAL-CANARY',name='Late personal name' WHERE id='target'"), db.prepare("INSERT INTO sessions VALUES('late-session','target')")]);
    const done = await erasure.deleteBlobs(pending.id);
    assert.equal(done.phase, 'complete'); assert.equal(done.deleted.operators, undefined);
    const kept = await db.prepare("SELECT * FROM operators WHERE id='target'").first<any>();
    assert.equal(kept!.name, 'Removed operator'); assert.equal(kept!.workspace_id, 'opaque-workspace');
    assert.ok(kept!.email.endsWith('@removed.invalid')); assert.ok(!kept!.email.includes(done.label.slice(7)), 'anonymous root cannot link to the audit label');
    assert.deepEqual(await db.prepare("SELECT name FROM operators WHERE id='peer'").first(), { name: 'Peer' });
    assert.equal((await db.prepare('SELECT count(*) n FROM sessions').first<any>())!.n, 0);
    assert.equal((await db.prepare('SELECT count(*) n FROM rer_erasure_scope').first<any>())!.n, 0);
    const after = await archive(portability);
    const ddl = sql.filter(statement => statement.startsWith('CREATE TABLE'));
    const rejected = await fixture(t, ddl, declaration);
    const laterJournal = { sourceIdentity: after.manifest.sourceIdentity, epoch: after.manifest.epoch, journal: after.manifest.journal };
    await assert.rejects(restore(rejected.portability, before, { options: { laterJournal } }), /erasure_epoch|erased_row/);
    assert.equal((await rejected.db.prepare('SELECT count(*) n FROM operators').first<any>())!.n, 0);
    const destination = await fixture(t, ddl, declaration);
    assert.equal((await restore(destination.portability, after)).status.phase, 'complete');
    assert.deepEqual(await destination.db.prepare("SELECT * FROM operators WHERE id='target'").first(), kept);
   }
  });
  
  await step('pre-deletion policy copies surviving history once before bounded child deletion', async t => {
    const { db, erasure } = await fixture(t, ['CREATE TABLE bookings(id TEXT PRIMARY KEY)', 'CREATE TABLE history(id TEXT PRIMARY KEY,booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,action TEXT)', 'CREATE TABLE anonymized_audit(action TEXT)', "INSERT INTO bookings VALUES('target')", "INSERT INTO history VALUES('h1','target','created'),('h2','target','moved')"], { entity: 'booking', root: { table: 'bookings' }, edges: [{ table: 'history', from: 'bookings', on: { booking_id: 'id' } }], beforeStatements: ({ db, subject }: any) => [db.prepare('INSERT INTO anonymized_audit SELECT action FROM history WHERE booking_id=?').bind(subject.id)] });
    const done = await erasure.run((await erasure.start('booking', { id: 'target' })).id, { rows: 1 });
    assert.equal(done.phase, 'complete');
    assert.deepEqual((await db.prepare('SELECT action FROM anonymized_audit ORDER BY action').all()).results, [{ action: 'created' }, { action: 'moved' }]);
  });
})






