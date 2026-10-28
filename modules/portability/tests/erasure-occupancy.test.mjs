import { runCases } from './cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, bundle, stage } from './regression-helpers.mjs';
import { tombstone } from '../journal.mjs';

test('restore checks local and supplied erasure journals before occupied rows and buckets', async t => {
  const ddl = ['CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT)', "INSERT INTO people VALUES('target','Personal')"];
  const source = await database(t, ddl, { product: 'fence-order' });
  const archive = await bundle(source.service);
  const hash = await tombstone(archive.manifest.sourceIdentity, 'people', { id: 'target' });
  await runCases(t, Array.from([false, true], (later, rowIndex) => [`${t.name}: later row ${rowIndex + 1}`, async t => {
    const target = await database(t, ddl, { product: 'fence-order' });
    await target.bucket.put('occupied', 'kept');
    if (!later) await target.db.prepare('INSERT INTO rer_portability_journal VALUES(?,?)').bind(archive.manifest.sourceIdentity, hash).run();
    const id = await stage(target.service, archive);
    const options = later ? { laterJournal: { sourceIdentity: archive.manifest.sourceIdentity, epoch: 1, journal: [hash] } } : {};
    await assert.rejects(target.service.imports.finalize(id, { archiveHash: archive.closing.archiveHash, ...options }), { code: 'erased_row:people' });
    assert.deepEqual(await target.db.prepare('SELECT * FROM people').first(), { id: 'target', name: 'Personal' });
    assert.equal(await (await target.bucket.get('occupied')).text(), 'kept');
}]));
});
