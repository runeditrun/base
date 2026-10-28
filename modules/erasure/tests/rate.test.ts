import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from '../../container/adapters/d1-workerd.mjs';
import { createErasure, defineErasure, rateCorrelation, rateEdges, rateWrite } from '../index.mjs';
import { createPortability } from '../../portability/index.mjs';

const schema = (await Promise.all(['../../portability/schema/portability.sql', '../schema/erasure.sql', '../schema/erasure-rates.sql'].map(p => readFile(new URL(p, import.meta.url), 'utf8')))).flatMap(s => s.split(';').map(s => s.trim()).filter(Boolean));
const CANARY = 'rate-canary-5e1b';
const root = { table: 'people', column: 'id' };
const counter = { table: 'rate_limits', keyColumn: 'key' };
const upsert = (db: D1Database, key: string) => db.prepare(`INSERT INTO rate_limits(key,window,count) VALUES(?,1,1)
  ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(key);
const attributable = (db: D1Database, subject: string, key: string) => rateWrite(db, { entity: 'person', root, subject, rateTable: 'rate_limits', rateKey: key }, [upsert(db, key)]);

test('BASE-DATA-003 an attributable rate row is erased with its person, and aggregates and other people keep theirs', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', compatibilityDate: '2026-09-01', d1Databases: { DB: 'rate' }, r2Buckets: { FILES: 'rate' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('FILES');
  await db.batch([...schema, 'CREATE TABLE people(id TEXT PRIMARY KEY,email TEXT NOT NULL)', 'CREATE TABLE rate_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL)',
    "INSERT INTO people VALUES('p1','ada@example.test'),('p2','grace@example.test')"].map(s => db.prepare(s)));
  const portability = await createPortability({ db, buckets: { FILES: bucket }, policy: { product: 'rate-proof', excludeTables: ['rer_erasure_blobs', 'rer_erasure_guard', 'rer_erasure_scope', 'rer_erasure_rates', 'rate_limits'] } });
  const erasure = createErasure({ db, buckets: { FILES: bucket }, portability, declarations: [defineErasure({ entity: 'person', root: { table: 'people' }, edges: rateEdges({ entity: 'person', root, counters: [counter] }) })] });

  // Written outside any person row: an email digest, a confirmation-token slice, a second hit, and the other person's.
  assert.equal((await attributable(db, 'p1', `email:${CANARY}`))[0].results[0].count, 1);
  assert.equal((await attributable(db, 'p1', `email:${CANARY}`))[0].results[0].count, 2);
  await attributable(db, 'p1', `token:${CANARY}`);
  await attributable(db, 'p2', 'email:grace-digest');
  await upsert(db, 'ip:203.0.113.9').run();

  const preview = await erasure.preview('person', { id: 'p1' });
  assert.deepEqual(preview.deleted, { people: 1, rer_erasure_rates: 2, rate_limits: 2 });
  const opened = await erasure.start('person', { id: 'p1' }, { planHash: preview.planHash });
  assert.equal((await erasure.commit(opened.id, { rows: 1, until: 0 })).phase, 'deleting');
  await attributable(db, 'p1', `late:${CANARY}`);                      // admitted while the erasure is running
  const done = await erasure.run(opened.id, { rows: 1 });
  assert.equal(done.phase, 'complete');

  const everything = JSON.stringify(await Promise.all((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf%' AND name NOT LIKE 'sqlite_%'").all()).results.map(async (r: any) => (await db.prepare(`SELECT * FROM "${r.name}"`).all()).results)));
  assert.ok(!everything.includes(CANARY) && !everything.includes('"p1"') && !everything.includes('ada@'), 'no table still holds the person or a key derived from them');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM rer_erasure_rates INDEXED BY rer_erasure_rates_subject WHERE entity='person' AND subject='p1'").first<any>())!.n, 0);
  assert.deepEqual((await db.prepare('SELECT key,count FROM rate_limits ORDER BY key').all()).results, [{ key: 'email:grace-digest', count: 1 }, { key: 'ip:203.0.113.9', count: 1 }]);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM rer_erasure_rates WHERE subject='p2'").first<any>())!.n, 1);

  // A write admitted after the subject is gone writes nothing at all.
  await assert.rejects(attributable(db, 'p1', `after:${CANARY}`), { code: 'subject_gone', status: 409 });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rate_limits').first<any>())!.n, 2);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rer_erasure_guard').first<any>())!.n, 0);
});

test('BASE-DATA-003 a redacted root admits no rate write after its erasure, and a declaration that cannot tell is refused', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', compatibilityDate: '2026-09-01', d1Databases: { DB: 'rate-redacted' }, r2Buckets: { FILES: 'rate-redacted' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('FILES');
  await db.batch([...schema, 'CREATE TABLE operators(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL)', 'CREATE TABLE rate_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL)',
    "INSERT INTO operators VALUES('op1','ada@example.test','Ada','active'),('op2','grace@example.test','Grace','active')"].map(s => db.prepare(s)));
  const portability = await createPortability({ db, buckets: { FILES: bucket }, policy: { product: 'rate-proof', excludeTables: ['rer_erasure_blobs', 'rer_erasure_guard', 'rer_erasure_scope', 'rer_erasure_rates', 'rate_limits'] } });
  const redact = { reason: 'stable anonymous attribution', set: ({ anonymousId }: { anonymousId: string }) => ({ email: anonymousId + '@removed.invalid', name: 'Removed operator', status: 'removed' }) };
  const declaration = (rateRoot: { table: string; column: string; live?: string }, set = redact.set) =>
    defineErasure({ entity: 'operator', root: { table: 'operators', redact: { ...redact, set } }, edges: rateEdges({ entity: 'operator', root: rateRoot, counters: [counter] }) });
  // The row survives redaction, so existence alone cannot end the subject's counting.
  assert.throws(() => declaration({ table: 'operators', column: 'id' }), { code: 'rate_root_live:0' });
  const live = { table: 'operators', column: 'id', live: "status<>'removed'" };
  const unended = createErasure({ db, buckets: { FILES: bucket }, portability, declarations: [declaration(live, ({ anonymousId }) => ({ email: anonymousId + '@removed.invalid', name: 'Removed operator', status: 'active' }))] });
  await assert.rejects(unended.preview('operator', { id: 'op1' }), { code: 'rate_root_live', status: 409 });

  const erasure = createErasure({ db, buckets: { FILES: bucket }, portability, declarations: [declaration(live)] });
  const write = (subject: string, key: string) => rateWrite(db, { entity: 'operator', root: live, subject, rateTable: 'rate_limits', rateKey: key }, [upsert(db, key)]);
  await write('op1', `email:${CANARY}`);
  await write('op2', 'email:grace-digest');
  await upsert(db, 'ip:203.0.113.9').run();
  const others = async () => [(await db.prepare("SELECT * FROM rate_limits WHERE key<>? ORDER BY key").bind(`email:${CANARY}`).all()).results, (await db.prepare("SELECT * FROM rer_erasure_rates WHERE subject<>'op1' ORDER BY rate_key").all()).results];
  const before = await others();

  // Resolved before the erasure commits, sent after it: the guard is evaluated in the write's own batch.
  const racing = [...rateCorrelation(db, { entity: 'operator', root: live, subject: 'op1', rateTable: 'rate_limits', rateKey: `race:${CANARY}` }), upsert(db, `race:${CANARY}`)];
  const preview = await erasure.preview('operator', { id: 'op1' });
  const opened = await erasure.start('operator', { id: 'op1' }, { planHash: preview.planHash });
  assert.equal((await erasure.run(opened.id, { rows: 500 })).phase, 'complete');
  assert.equal((await db.prepare("SELECT status FROM operators WHERE id='op1'").first<any>())!.status, 'removed');
  await assert.rejects(db.batch(racing));
  await assert.rejects(write('op1', `after:${CANARY}`), { code: 'subject_gone', status: 409 });

  const everything = JSON.stringify([(await db.prepare('SELECT * FROM rate_limits').all()).results, (await db.prepare('SELECT * FROM rer_erasure_rates').all()).results]);
  assert.ok(!everything.includes(CANARY) && !everything.includes('"op1"'), 'no counter or correlation of the erased operator remains');
  assert.deepEqual(await others(), before);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rer_erasure_guard').first<any>())!.n, 0);
});
