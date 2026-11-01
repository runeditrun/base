import test from 'node:test';
import { effectCount } from './scale-size.ts';
import assert from 'node:assert/strict';
import { providerScale } from './preserved-provider-scale-fixture.ts';
import { nativeSetTargets } from './preserved-native-set.ts';
import { canonicalJson, sha256, ImportSizeLimitError, readD1ImportUndoReport, readD1ImportOriginals, readD1PersistedImport, resumeD1Import, undoD1Import } from '../../src/d1/index.ts';
import { decodeProvenance } from '../../src/storage/provenance.ts';
import { nativeSetGuards } from '../../src/d1/native-set.ts';
import { packGuards } from '../../src/d1/budget.ts';
import { batchBytes } from '../../src/d1/transport.ts';

test('real D1: public first undo fences all native effects and export enforces its exact snapshot limit', async t => {
  const r = await providerScale(t, 0), db = r.db(), custody = await r.custody();
  // Every native effect starts unchanged. The late value edit preserves its
  // revision, so only an exact complete snapshot can reject this first batch.
  let injected = false, before: any;
  const racing = { ...nativeSetTargets, async preparePreservedUndo(...args: Parameters<NonNullable<typeof nativeSetTargets.preparePreservedUndo>>) {
    const snapshot = await nativeSetTargets.preparePreservedUndo!(...args);
    assert.equal(snapshot.nativeRows!.length, effectCount); assert.equal(snapshot.observations.length, effectCount);
    await db.prepare("UPDATE native_records SET value_json=json_set(value_json,'$.label','late edit') WHERE kind='record' AND id=?").bind(String(effectCount / 2 - 1)).run();
    injected = true; before = (await db.prepare('SELECT * FROM ik_jobs').all()).results; return snapshot;
  } };
  await assert.rejects(r.meter().request('first-undo-late-native', () => undoD1Import(r.job.id, { ...r.context(), storage: { ...r.context().storage, targets: racing } })), /IMPORT_ATOMIC_GUARD/);
  assert.equal(injected, true); assert.deepEqual((await db.prepare('SELECT * FROM ik_jobs').all()).results, before);
  assert.deepEqual(await r.counts(), { native_records: effectCount, ik_provenance: effectCount, ik_sources: effectCount / 2, ik_d1_reversal_reports: 0, ik_d1_assertions: 0, ik_d1_creation_plans: 0 });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ik_provenance WHERE reversed=0').first())!.n, effectCount);
  assert.equal((await r.meter().request('first-undo-public-resume', () => resumeD1Import(r.job.id, { ...r.context(), batchSize: 2 }))).state, 'undoing');
  assert.equal((await r.counts()).ik_d1_reversal_reports, 2);
  assert.equal((await r.counts()).native_records, effectCount - 1);
  await r.reopen();
  const report = await r.meter().request('first-disposition-after-reopen', () => readD1ImportUndoReport(r.job.id, r.context()));
  assert.equal(report.cursor, 2); assert.equal(report.total, 2);
  assert.equal(report.dispositions[0].reason, 'edited'); assert.equal(report.dispositions[1].disposition, 'reversed');
  const nativeDb = r.db(), nativeRows = await nativeSetTargets.list(nativeDb, r.context().destination);
  const nativeBytes = batchBytes(packGuards(nativeSetGuards(nativeSetTargets, nativeRows, r.context().destination).map(entry => entry.guard), true));
  const exportLimit = 2 * 1024 * 1024;
  const exportRequest = () => r.meter().request('full-native-persisted-export', () => readD1PersistedImport(r.context()));
  let exported;
  // The API promises one atomic native fence capped at 2 MiB. When even
  // the native predicates exceed it, require the named refusal and still
  // independently check every durable native/provenance value below.
  if (nativeBytes > exportLimit) {
    await assert.rejects(exportRequest, error => error instanceof ImportSizeLimitError && error.message === 'IMPORT_D1_TRANSPORT_LIMIT' && canonicalJson(error.targetKinds) === canonicalJson(['link', 'record']));
    exported = { rows: nativeRows, provenance: (await nativeDb.prepare('SELECT * FROM ik_provenance WHERE job_id=? AND reversed=0').bind(r.job.id).all()).results.map(decodeProvenance) };
  } else exported = await exportRequest();
  assert.equal(exported.rows.length, effectCount - 1); assert.equal(exported.provenance.length, effectCount - 1);
  const removed = report.dispositions[1];
  assert.ok(exported.rows.every(row => row.targetKind !== removed.targetKind || row.targetId !== removed.targetId));
  for (const row of exported.rows) {
    const label = row.targetKind === 'record' && row.targetId === String(effectCount / 2 - 1) ? 'late edit' : 'original';
    assert.deepEqual(row.value, { id: row.targetId, label });
  }
  const originalValues = new Map(r.plan.entries.flatMap(entry => entry.effects.map(effect => [`${effect.targetKind}:${effect.targetId}`, sha256(canonicalJson(effect.value))])));
  assert.ok(exported.provenance.every(p => p.jobId === r.job.id && !p.reversed && p.valueHash === originalValues.get(`${p.targetKind}:${p.targetId}`)));
  const originals = await r.meter().request('full-set-retained-originals', () => readD1ImportOriginals(r.job.id, r.context()));
  assert.deepEqual(originals.map(o => o.original), r.source.artifacts.map(a => ({ ...a.original, status: 'retained' })));
  assert.deepEqual(await r.custody(), custody);
  console.log(JSON.stringify({ nativeProviderScale: { effects: effectCount, native: await r.counts(), ...r.summary() } }));
});
