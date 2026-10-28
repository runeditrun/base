import { canonical, changedQuantity, check, commitInput, effects, equal, refused, reviewed, value } from './assertions.mjs';

export async function commitmentAndAuthority(runtime) {
  const f = runtime.fixture, buyer = f.actors.buyer;
  const stale = await reviewed(runtime, 'stale-commercial-review');
  await runtime.controls.changeCommercialFacts();
  refused(await runtime.request(buyer, 'commit', commitInput(stale, 'stale-key')), ['stale_review'], 'changed commercial revision');
  effects(await runtime.controls.effects(), 0, 'stale commit has no partial effects');
  const current = value(await runtime.request(buyer, 'review', { draftId: stale.id, expectedRevision: stale.revision }), 'review changed facts');
  const wrongFingerprint = { ...commitInput(current, 'wrong-fingerprint'), fingerprint: '0'.repeat(64) };
  refused(await runtime.request(buyer, 'commit', wrongFingerprint), ['stale_review'], 'changed review fingerprint');
  const input = commitInput(current, 'parallel-key');
  const receipts = (await Promise.all(Array.from({ length: 4 }, () => runtime.request(buyer, 'commit', input)))).map(result => value(result, 'parallel native commitment'));
  equal(new Set(receipts.map(receipt => receipt.snapshotId)).size, 1, 'parallel requests recover one snapshot');
  equal(new Set(receipts.map(receipt => canonical(receipt.outcome))).size, 1, 'parallel requests recover one native outcome');
  equal(receipts.filter(receipt => !receipt.replay).length, 1, 'exactly one parallel request creates effects');
  effects(await runtime.controls.effects(), 1, 'one atomic native commitment');
  const replay = value(await runtime.request(buyer, 'commit', input), 'same key replay');
  equal(replay.replay, true, 'replay is reported');
  equal(replay.snapshotId, receipts[0].snapshotId, 'replay recovers immutable snapshot');
  refused(await runtime.request(f.actors.peer, 'commit', input), ['authority_refused', 'idempotency_conflict'], 'same key from foreign actor');
  refused(await runtime.request(buyer, 'commit', { ...input, key: 'different-key-same-review' }), ['idempotency_conflict', 'revision_conflict'], 'different key cannot recommit same review');
  const changed = await reviewed(runtime, 'changed-quantity', changedQuantity(f.selection));
  refused(await runtime.request(buyer, 'commit', commitInput(changed, input.key)), ['idempotency_conflict'], 'same key with changed quantity and fingerprint');
  await runtime.controls.setMembership(buyer, false);
  refused(await runtime.request(buyer, 'commit', input), ['authority_refused'], 'revoked replay');
  refused(await runtime.request(buyer, 'snapshot', { id: replay.snapshotId }), ['authority_refused'], 'revoked snapshot');
  await runtime.controls.setMembership(buyer, true);
  effects(await runtime.controls.effects(), 1, 'replay and revocation retain one outcome');

  const raceDraft = value(await runtime.request(buyer, 'draft', { id: 'optimistic-edit', expectedRevision: 0, selection: f.selection, previous: null }), 'initial editable draft');
  const edits = await Promise.all([f.selection, changedQuantity(f.selection)].map(selection => runtime.request(buyer, 'draft', { id: raceDraft.id, expectedRevision: raceDraft.revision, selection, previous: null })));
  equal(edits.filter(result => result.ok).length, 1, 'one concurrent draft edit wins');
  refused(edits.find(result => !result.ok), ['revision_conflict'], 'concurrent stale draft edit');
  const winningDraft = value(edits.find(result => result.ok), 'winning native edit');
  equal(winningDraft.revision, raceDraft.revision + 1, 'revision advances once');
  refused(await runtime.request(buyer, 'review', { draftId: raceDraft.id, expectedRevision: raceDraft.revision }), ['revision_conflict'], 'stale draft revision');

  const guarded = await reviewed(runtime, 'native-guarded-command');
  await runtime.controls.setNativeCommitAllowed(false);
  refused(await runtime.request(buyer, 'commit', commitInput(guarded, 'guarded-native-key')), ['native_conflict'], 'native state guard');
  effects(await runtime.controls.effects(), 1, 'native conflict rolls back snapshot and all native effects');
  await runtime.controls.setNativeCommitAllowed(true);
  check(value(await runtime.request(buyer, 'commit', commitInput(guarded, 'guarded-native-key')), 'retry after native guard correction').replay === false, 'failed native guard did not consume operation key');
  effects(await runtime.controls.effects(), 2, 'corrected native commit publishes one complete outcome');
}
