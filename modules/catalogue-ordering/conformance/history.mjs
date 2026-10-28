import { canonical, check, commercialOnly, commitInput, effects, equal, refused, reviewed, value } from './assertions.mjs';

export async function exportAndUpgrade(runtime) {
  const f = runtime.fixture, buyer = f.actors.buyer;
  const original = value(await runtime.request(buyer, 'snapshot', { id: f.history.id }), 'populated upgrade history');
  equal(original.status, 'legacy', 'historical metadata remains explicitly legacy');
  equal(original.id, f.history.id, 'native historical ID retained');
  equal(original.original, f.history.original, 'historical bytes retained');
  equal(original.currency, null, 'unknown historical currency remains unknown');
  equal(original.arithmetic, null, 'unknown historical arithmetic remains unknown');
  equal(original.source, f.history.source, 'native historical source revision retained');
  const review = await reviewed(runtime, 'exported-current-order');
  const input = commitInput(review, 'exported-operation-key');
  const receipt = value(await runtime.request(buyer, 'commit', input), 'current order for scoped export');
  const exported = value(await runtime.request(buyer, 'export', { subject: f.selection.subject, after: null, limit: 50 }), 'native scoped export');
  const artifact = exported.artifact;
  equal(exported.next, null, 'bounded export completed');
  equal(artifact.records.length, 2, 'upgrade and current snapshot exported together');
  check(artifact.records.every(record => canonical(record.snapshot.subject) === canonical(f.selection.subject)), 'export is restricted to current subject');
  const legacy = artifact.records.find(record => record.snapshot.id === original.id);
  equal(legacy.snapshot, original, 'export preserves historical original');
  check(legacy.sources.some(source => source.source === f.history.source.source && source.legacyId === f.history.source.id && source.revision === f.history.source.revision), 'export retains populated source mapping');
  check(artifact.records.find(record => record.snapshot.id === receipt.snapshotId).receipts.length === 1, 'export retains once-only receipt evidence');
  for (const secret of f.forbiddenExportStrings) check(!JSON.stringify(artifact).includes(secret), 'export excludes live session credentials');
  commercialOnly(artifact, 'scoped export');
  equal(await runtime.controls.verifyArtifact(artifact), true, 'artifact digest verifies');
  const altered = structuredClone(artifact);
  altered.records.find(record => record.snapshot.status === 'legacy').snapshot.original += '\nchanged';
  equal(await runtime.controls.verifyArtifact(altered), false, 'changed historical bytes invalidate digest');

  for (const [candidate, valid] of [[altered, false], [artifact, true]]) {
    const recovered = await runtime.controls.restore(candidate);
    try {
      if (!valid) {
        refused(recovered.result, ['invalid_artifact'], 'tampered artifact recovery');
        equal((await recovered.inspect()).history.length, 0, 'invalid artifact restores nothing');
        continue;
      }
      equal(value(recovered.result, 'inert artifact recovery').restored, artifact.records.length, 'all verified history recovered');
      const inspected = await recovered.inspect();
      effects(inspected.effects, 0, 'recovery has no live native effects');
      equal(inspected.sessions, 0, 'recovery does not create sessions');
      equal(inspected.memberships, 0, 'recovery does not create memberships');
      equal(inspected.drafts, 0, 'recovery does not create drafts');
      equal(inspected.history.length, artifact.records.length, 'immutable history recovered');
      equal(inspected.history.find(row => row.id === original.id).snapshot, original, 'recovered legacy bytes and metadata');
      check(inspected.sources.some(source => source.legacy_id === f.history.source.id && source.revision === f.history.source.revision), 'recovered original source mapping');
      refused(await recovered.request(buyer, 'offers', { subject: f.selection.subject, cursor: null, limit: 20 }), ['authority_refused'], 'old credential cannot list in recovered installation');
      refused(await recovered.request(buyer, 'snapshot', { id: receipt.snapshotId }), ['authority_refused'], 'old credential cannot read recovered history');
      refused(await recovered.request(buyer, 'commit', input), ['authority_refused'], 'recovered receipt cannot replay an external effect');
      const after = await recovered.inspect();
      effects(after.effects, 0, 'denied recovered replay has no effects');
    } finally { await recovered.close(); }
  }
}
