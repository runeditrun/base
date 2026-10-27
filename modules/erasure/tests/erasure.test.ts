import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createPortability, canonicalJson, sha256 } from '../../portability/index.mjs';
import { createErasure, defineErasure } from '../index.mjs';
import { initializeD1ImportStorage, planD1Import, createD1ImportJob, resumeD1Import, eraseD1ImportTarget, sha256 as kitSha, canonicalJson as kitJson } from '../../import-kit/src/d1/index.ts';

const sqlFile = async (path: string) => (await readFile(new URL(path, import.meta.url), 'utf8')).split(';').map(s => s.trim()).filter(Boolean);
const schema = [...await sqlFile('../../portability/schema/portability.sql'), ...await sqlFile('../schema/erasure.sql')];
const product = [
  'CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,detail TEXT)',
  'CREATE TABLE notes(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,body TEXT NOT NULL)',
  'CREATE TABLE files(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,name TEXT NOT NULL,storage_key TEXT NOT NULL)',
  'CREATE TABLE file_tags(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(file_id,tag))',
  'CREATE TABLE mentions(body TEXT)',
  'CREATE TABLE audit_events(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details_json TEXT NOT NULL)',
  'CREATE TABLE opt_outs(hash TEXT PRIMARY KEY)',
];
const CANARY = 'canary-7f3a';
const person = defineErasure({
  entity: 'person', root: { table: 'people' },
  edges: [
    { table: 'notes', from: 'people', on: { person_id: 'id' } },
    { table: 'files', from: 'people', on: { person_id: 'id' }, blob: { bucket: 'FILES', keyColumn: 'storage_key' } },
    { table: 'file_tags', from: 'files', on: { file_id: 'id' } },
    { table: 'mentions', from: 'people', where: 'instr(body,?)>0', params: ['email'] },
  ],
  audit: [
    { table: 'audit_events', column: 'entity_id', of: 'people', where: "entity_type='person'", clear: { details_json: '{}' } },
    { table: 'audit_events', column: 'entity_id', of: 'notes', where: "entity_type='note'", clear: { details_json: '{}' } },
  ],
  retain: [{ table: 'opt_outs', reason: 'keyed opt-out hash prevents re-contact' }],
});

async function fixture(t: any, extra: string[] = []) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-09-01', d1Databases: { DB: 'erasure' }, r2Buckets: { FILES: 'erasure-files' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('FILES');
  await db.batch([...schema, ...product, ...extra].map(s => db.prepare(s)));
  const rows = [
    ["INSERT INTO people VALUES('p1',?,?,?)", `Ada ${CANARY}`, `ada.${CANARY}@example.test`, JSON.stringify({ phone: `+1 ${CANARY}` })],
    ["INSERT INTO people VALUES('p2','Grace','grace@example.test','{}')"],
    ...Array.from({ length: 30 }, (_, i) => [`INSERT INTO notes VALUES('n${i}','p1',?)`, `note ${i} ${CANARY}`]),
    ["INSERT INTO notes VALUES('peer-note','p2','kept')"],
    ...[0, 1, 2].map(i => [`INSERT INTO files VALUES('f${i}','p1',?,'obj-${i}')`, `${CANARY}-${i}.txt`]),
    ["INSERT INTO files VALUES('peer-file','p2','kept.txt','obj-peer')"],
    ["INSERT INTO file_tags VALUES('f0','a'),('f0','b'),('f1','a')"],
    ['INSERT INTO mentions VALUES(?),(?),(?)', `cc ada.${CANARY}@example.test`, `again ada.${CANARY}@example.test`, 'grace@example.test only'],
    ["INSERT INTO audit_events VALUES('a1','person','p1',?),('a2','note','n0',?),('a3','person','p2','{}')", JSON.stringify({ name: `Ada ${CANARY}` }), JSON.stringify({ body: CANARY })],
    ["INSERT INTO opt_outs VALUES('keyed-hash')"],
  ];
  await db.batch(rows.map(([sql, ...v]) => v.length ? db.prepare(sql).bind(...v) : db.prepare(sql)));
  for (const key of ['obj-0', 'obj-1', 'obj-2']) await bucket.put(key, `${CANARY} body ${key}`);
  await bucket.put('obj-peer', 'peer body');
  const portability = await createPortability({ db, buckets: { FILES: bucket }, policy: { product: 'erasure-test', excludeTables: ['rer_erasure_blobs', 'rer_erasure_guard'], buckets: { FILES: { objectReferences: { table: 'files', keyColumn: 'storage_key' } } } } });
  const erasure = createErasure({ db, buckets: { FILES: bucket }, portability, declarations: [person] });
  const dump = async () => JSON.stringify(await Promise.all(['people', 'notes', 'files', 'file_tags', 'mentions', 'audit_events', 'opt_outs', 'rer_erasure_operations', 'rer_erasure_blobs', 'rer_portability_journal'].map(async n => (await db.prepare(`SELECT * FROM ${n}`).all()).results)));
  return { mf, db, bucket, erasure, dump };
}

test("erasure journey removes only the declared subject graph, fences it and resumes its blob phase", async t => {
  const step = namedSteps(t);
  await step('BASE-DATA-003 cascade deletes the declared graph in bounded steps, fences every row, anonymises audit and writes a value-free receipt', async t => {
    const { db, bucket, erasure, dump } = await fixture(t);
    const before = Object.fromEntries(await Promise.all(['people', 'notes', 'files', 'file_tags'].map(async n => [n, (await db.prepare(`SELECT * FROM ${n} WHERE ${n === 'file_tags' ? "file_id IN ('f0','f1','f2')" : n === 'people' ? "id='p1'" : "person_id='p1'"}`).all()).results])));
    const mentions = (await db.prepare('SELECT rowid AS rowid FROM mentions WHERE instr(body,?)>0').bind(`ada.${CANARY}@example.test`).all()).results;
  
    const preview = await erasure.preview('person', { id: 'p1' });
    assert.deepEqual(preview.deleted, { people: 1, notes: 30, files: 3, file_tags: 3, mentions: 2 });
    assert.deepEqual([preview.blobs, preview.audited.audit_events, preview.retained], [3, 2, [{ table: 'opt_outs', reason: 'keyed opt-out hash prevents re-contact' }]]);
    assert.ok(!JSON.stringify(preview).includes(CANARY));
  
    const opened = await erasure.start('person', { id: 'p1' }, { planHash: preview.planHash });
    assert.equal(opened.phase, 'deleting');
    const done = await erasure.run(opened.id, { rows: 7 });
    assert.equal(done.phase, 'complete');
    assert.deepEqual(done.deleted, done.planned);
    assert.deepEqual(done.blobs, { total: 3, deleted: 3 });
    assert.ok((await db.prepare('SELECT step FROM rer_erasure_operations WHERE id=?').bind(opened.id).first<{ step: number }>())!.step > 4, 'committed in several bounded steps');
  
    const after = await dump();
    assert.ok(!after.includes(CANARY), 'no planted value survives in any table');
    assert.ok(!JSON.stringify(done).includes('p1') && !JSON.stringify(done).includes(CANARY));
    assert.match(done.label, /^erased:[0-9a-f]{32}$/);
    const audits = (await db.prepare("SELECT id,entity_id,details_json FROM audit_events ORDER BY id").all()).results;
    assert.deepEqual(audits, [{ id: 'a1', entity_id: done.label, details_json: '{}' }, { id: 'a2', entity_id: done.label, details_json: '{}' }, { id: 'a3', entity_id: 'p2', details_json: '{}' }]);
    for (const [table, n] of [['people', 1], ['notes', 1], ['files', 1], ['opt_outs', 1], ['mentions', 1]] as const) assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n, n);
    for (const key of ['obj-0', 'obj-1', 'obj-2']) assert.equal(await bucket.head(key), null);
    assert.ok(await bucket.head('obj-peer'));
  
    const source = (await db.prepare('SELECT source_identity FROM rer_portability_state WHERE id=1').first<{ source_identity: string }>())!.source_identity;
    const journal = new Set((await db.prepare('SELECT tombstone FROM rer_portability_journal').all<{ tombstone: string }>()).results.map(r => r.tombstone));
    const key = (table: string, row: any) => table === 'file_tags' ? { file_id: row.file_id, tag: row.tag } : { id: row.id };
    const expected = [...Object.entries(before).flatMap(([table, list]) => list.map(row => [table, key(table, row)])), ...mentions.map(r => ['mentions', { rowid: r.rowid }])];
    assert.equal(expected.length, 39);
    for (const [table, k] of expected) assert.ok(journal.has(await sha256(canonicalJson([source, table, k]))), `${table} row is fenced`);
  });
  
  await step('BASE-DATA-003 erasing one subject takes only its rows from an integer id table, across bounded steps', async t => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-09-01', d1Databases: { DB: 'integer-id' } }));
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    await db.batch([...schema, 'CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL)', 'CREATE TABLE aliases(id INTEGER PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id))',
      "INSERT INTO projects VALUES('cap','Cap'),('pa','A'),('pb','B')", "INSERT INTO aliases VALUES(1,'cap'),(2,'pa'),(3,'pb'),(4,'cap'),(5,'pa'),(6,'cap')"].map(s => db.prepare(s)));
    const portability = await createPortability({ db, policy: { product: 'integer-id', excludeTables: ['rer_erasure_blobs', 'rer_erasure_guard'] } });
    const erasure = createErasure({ db, portability, declarations: [defineErasure({ entity: 'project', root: { table: 'projects' }, edges: [{ table: 'aliases', from: 'projects', on: { project: 'id' } }] })] });
    const preview = await erasure.preview('project', { id: 'cap' });
    assert.deepEqual(preview.deleted, { projects: 1, aliases: 3 });
    const done = await erasure.run((await erasure.start('project', { id: 'cap' }, { planHash: preview.planHash })).id, { rows: 1 });
    assert.equal(done.phase, 'complete');
    assert.deepEqual(done.deleted, { aliases: 3, projects: 1 });
    assert.deepEqual((await db.prepare('SELECT id,project FROM aliases ORDER BY id').all()).results, [{ id: 2, project: 'pa' }, { id: 3, project: 'pb' }, { id: 5, project: 'pa' }]);
    assert.deepEqual((await db.prepare('SELECT id FROM projects ORDER BY id').all()).results, [{ id: 'pa' }, { id: 'pb' }]);
  });
  
  await step('BASE-DATA-003 interruption after the D1 commit reports pending, a repeated request changes nothing, and only the blob phase completes it', async t => {
    const { bucket, erasure, dump } = await fixture(t);
    const opened = await erasure.start('person', { id: 'p1' });
    const committed = await erasure.commit(opened.id);
    assert.equal(committed.phase, 'blobs');
    assert.equal(committed.completedAt, null);
    assert.deepEqual(committed.blobs, { total: 3, deleted: 0 });
    assert.ok(await bucket.head('obj-0'), 'bytes remain until the blob phase runs');
    const snapshot = await dump();
    await assert.rejects(erasure.start('person', { id: 'p1' }), { code: 'subject_not_found', status: 404 });
    assert.equal(await dump(), snapshot);
    assert.equal((await erasure.receipt(opened.id)).phase, 'blobs');
    const complete = await erasure.deleteBlobs(opened.id);
    assert.equal(complete.phase, 'complete');
    for (const key of ['obj-0', 'obj-1', 'obj-2']) assert.equal(await bucket.head(key), null);
  });
  
  await step('BASE-DATA-003 an undeclared foreign-key dependent refuses the erasure before any change', async t => {
    const { erasure, dump } = await fixture(t, ['CREATE TABLE invoices(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id) ON DELETE CASCADE)']);
    const snapshot = await dump();
    await assert.rejects(erasure.preview('person', { id: 'p1' }), { code: 'undeclared_dependent:invoices:people' });
    await assert.rejects(erasure.start('person', { id: 'p1' }), { code: 'undeclared_dependent:invoices:people' });
    assert.equal(await dump(), snapshot);
  });
  
  await step('BASE-DATA-003 nativeStatements run inside import-kit erasure: kit custody, product cascade and fence commit in one batch', async t => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-09-01', d1Databases: { DB: 'kit' } }));
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    await initializeD1ImportStorage(db);
    await db.batch([...schema, 'CREATE TABLE contacts(destination TEXT,kind TEXT,id TEXT PRIMARY KEY,revision TEXT,email TEXT)', 'CREATE TABLE evidence(id TEXT PRIMARY KEY,detail TEXT)',
      'CREATE TABLE sessions(id TEXT PRIMARY KEY,actor TEXT,enabled INTEGER,expires INTEGER)', "INSERT INTO sessions VALUES('session','owner',1,9999999999999)"].map(s => db.prepare(s)));
    const sql = (text: string, ...params: any[]) => ({ sql: text, params });
    const targets: any = {
      async read(d: any, destination: string, kind: string, id: string) {
        const row = await d.prepare('SELECT c.*,e.detail FROM contacts c JOIN evidence e ON e.id=c.id WHERE c.destination=? AND c.kind=? AND c.id=?').bind(destination, kind, id).first();
        return row ? { destination, targetKind: kind, targetId: id, revision: row.revision, value: { email: row.email, evidence: row.detail } } : undefined;
      },
      matches(row: any, destination: string, kind: string, id: string) {
        return row ? sql('EXISTS(SELECT 1 FROM contacts c JOIN evidence e ON e.id=c.id WHERE c.destination=? AND c.kind=? AND c.id=? AND c.revision=? AND c.email=? AND e.detail=?)', destination, kind, id, row.revision, row.value.email, row.value.evidence)
          : sql('NOT EXISTS(SELECT 1 FROM contacts WHERE destination=? AND kind=? AND id=?)', destination, kind, id);
      },
      matchesCount(count: number, destination: string) { return sql('(SELECT COUNT(*) FROM contacts WHERE destination=?)=?', destination, count); },
      write(row: any) { return [sql('INSERT INTO contacts(destination,kind,id,revision,email) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,email=excluded.email', row.destination, row.targetKind, row.targetId, row.revision, row.value.email), sql('INSERT INTO evidence(id,detail) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail', row.targetId, row.value.evidence)]; },
      remove(destination: string, kind: string, id: string) { return [sql('DELETE FROM evidence WHERE id=?', id), sql('DELETE FROM contacts WHERE destination=? AND kind=? AND id=?', destination, kind, id)]; },
      async list(d: any, destination: string) { const { results } = await d.prepare('SELECT kind,id FROM contacts WHERE destination=?').bind(destination).all(); return Promise.all(results.map((r: any) => this.read(d, destination, r.kind, r.id))); },
    };
    const payloads = [0, 1].map(i => ({ email: `person${i}.${CANARY}@example.test`, evidence: `history ${CANARY}` }));
    const bytes = kitJson(payloads);
    const bundle: any = { diagnostics: [], artifacts: [{ name: 'contacts.json', sha256: kitSha(bytes), size: Buffer.byteLength(bytes), original: { status: 'unavailable', reason: 'not-supplied' } }],
      records: payloads.map((payload, i) => ({ namespace: 'archive', kind: 'contact', sourceId: String(i), payload, payloadHash: kitSha(kitJson(payload)), artifactHash: kitSha(bytes), location: { artifact: 'contacts.json', row: i + 1 } })) };
    const context: any = { destination: 'workspace', namespace: 'archive', mappingVersion: 'v1', batchSize: 1, storage: { database: db, targets },
      authorization: { principalId: 'owner', predicate: () => sql('EXISTS(SELECT 1 FROM sessions WHERE id=? AND actor=? AND enabled=1 AND expires>unixepoch()*1000)', 'session', 'owner') } };
    const plan = await planD1Import(bundle, { version: 'v1', map: (r: any) => ({ effects: [{ targetKind: 'contact', targetId: r.sourceId, value: r.payload }] }) }, context);
    const job = await createD1ImportJob(plan, { ...context, operationKey: 'kit-file', reviewedFingerprint: plan.fingerprint });
    await resumeD1Import(job.id, context);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM contacts').first<{ n: number }>())!.n, 2);
  
    const portability = await createPortability({ db, policy: { product: 'kit-test', excludeTables: ['ik_%', 'sessions', 'rer_erasure_blobs', 'rer_erasure_guard'] } });
    const erasure = createErasure({ db, portability, declarations: [defineErasure({ entity: 'contact', root: { table: 'contacts' }, edges: [{ table: 'evidence', from: 'contacts', on: { id: 'id' } }] })] });
    const native = await erasure.nativeStatements('contact', { id: '0' });
    assert.ok(native.statements.every((s: any) => typeof s.sql === 'string' && Array.isArray(s.params)));
    const result = await eraseD1ImportTarget('contact', '0', native.statements, context);
    assert.equal(result.erasedRecords, 1);
    assert.deepEqual((await db.prepare('SELECT id FROM contacts').all()).results, [{ id: '1' }]);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM evidence WHERE id='0'").first<{ n: number }>())!.n, 0);
    const source = (await db.prepare('SELECT source_identity FROM rer_portability_state').first<{ source_identity: string }>())!.source_identity;
    for (const [table, key] of [['contacts', { id: '0' }], ['evidence', { id: '0' }]] as const) {
      assert.ok(await db.prepare('SELECT 1 FROM rer_portability_journal WHERE tombstone=?').bind(await sha256(canonicalJson([source, table, key]))).first(), `${table} row is fenced`);
    }
    assert.equal((await erasure.deleteBlobs(native.operationId)).phase, 'complete');
  });
})









