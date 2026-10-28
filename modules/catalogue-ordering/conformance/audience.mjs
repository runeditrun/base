import { canonical, check, commercialOnly, commitInput, equal, refused, reviewed, value } from './assertions.mjs';

export async function audienceAndArithmetic(runtime) {
  const f = runtime.fixture, buyer = f.actors.buyer, outsider = f.actors.outsider;
  refused(await runtime.request(null, 'offers', { subject: f.selection.subject, cursor: null, limit: 20 }), ['authority_refused'], 'anonymous offer list');
  refused(await runtime.request(outsider, 'offers', { subject: f.selection.subject, cursor: null, limit: 20 }), ['authority_refused'], 'other audience offer list');
  refused(await runtime.request(outsider, 'selection', f.selection), ['authority_refused'], 'other audience direct selection');
  const listed = value(await runtime.request(buyer, 'offers', { subject: f.selection.subject, cursor: null, limit: 20 }), 'authorized offers');
  check(listed.offers.some(offer => offer.offerId === f.selection.lines[0].offerId), 'native selected offer is listed');
  check(listed.offers.every(offer => canonical(offer.audience) === canonical(f.selection.subject)), 'list remains scoped to native audience');
  commercialOnly(listed, 'offer list');
  refused(await runtime.request(buyer, 'selection', f.foreignSelection), ['unavailable_offer', 'authority_refused'], 'foreign direct offer');
  refused(await runtime.request(buyer, 'selection', f.missingSelection), ['unavailable_offer'], 'missing offer');
  refused(await runtime.request(buyer, 'selection', f.unpricedSelection), ['unpriced_offer'], 'missing price remains unpriced');
  const invalid = structuredClone(f.selection);
  invalid.lines[0].quantity = { coefficient: '0', scale: 0 };
  refused(await runtime.request(buyer, 'selection', invalid), ['invalid_quantity', 'invalid_input'], 'zero quantity');
  refused(await runtime.request(buyer, 'selection', { ...f.selection, price: { coefficient: '0', scale: 0 } }), ['invalid_input'], 'request supplied price');
  refused(await runtime.request(buyer, 'selection', { ...f.selection, actor: { personId: 'other-person' } }), ['invalid_input'], 'request supplied actor');

  for (const [index, example] of f.profiles.entries()) {
    const resolved = value(await runtime.request(buyer, 'selection', example.selection), `native ${example.profile} selection`);
    equal(resolved.total, example.total, `${example.profile}: total`);
    equal(resolved.lines[0].extension, example.extension, `${example.profile}: extension`);
    equal(resolved.lines[0].arithmetic.id, example.arithmeticId, `${example.profile}: stored arithmetic`);
    if ('baseQuantity' in example) equal(resolved.lines[0].baseQuantity, example.baseQuantity, `${example.profile}: exact converted quantity`);
    if (example.baseQuantityRatio) equal(resolved.lines[0].baseQuantityRatio, example.baseQuantityRatio, `${example.profile}: exact converted ratio`);
    if (example.calculationBasis) equal(resolved.lines[0].calculationBasis, example.calculationBasis, 'native final calculation classification');
    if (example.inputFingerprint) equal(resolved.lines[0].inputFingerprint, example.inputFingerprint, 'native final input evidence');
    commercialOnly(resolved, `${example.profile}: selection`);
    const prepared = await reviewed(runtime, `profile-${index}`, example.selection);
    const committed = value(await runtime.request(buyer, 'commit', commitInput(prepared, `profile-key-${index}`)), `${example.profile}: native outcome`);
    const frozen = value(await runtime.request(buyer, 'snapshot', { id: committed.snapshotId }), `${example.profile}: frozen snapshot`);
    equal(frozen.total, example.total, `${example.profile}: frozen total`);
    equal(frozen.lines[0], resolved.lines[0], `${example.profile}: frozen line evidence`);
  }

  const review = await reviewed(runtime, 'copied-commercial-facts');
  commercialOnly(review, 'review');
  const receipt = value(await runtime.request(buyer, 'commit', commitInput(review, 'copied-facts-key')), 'native commitment');
  const before = value(await runtime.request(buyer, 'snapshot', { id: receipt.snapshotId }), 'committed snapshot');
  equal(before.status, 'specified', 'new snapshot metadata is specified');
  equal(before.terms, review.commercial.terms, 'reviewed native terms copied');
  await runtime.controls.changeCommercialFacts();
  equal(value(await runtime.request(buyer, 'snapshot', { id: receipt.snapshotId }), 'snapshot after native changes'), before, 'immutable copied commercial facts');
  refused(await runtime.request(outsider, 'snapshot', { id: receipt.snapshotId }), ['authority_refused'], 'other audience snapshot');
  refused(await runtime.request(outsider, 'export', { subject: f.selection.subject, after: null, limit: 50 }), ['authority_refused'], 'other audience export');
  const amendment = await reviewed(runtime, 'commercial-amendment', f.selection, before.id);
  const amended = value(await runtime.request(buyer, 'commit', commitInput(amendment, 'amendment-key')), 'native linked amendment');
  const after = value(await runtime.request(buyer, 'snapshot', { id: amended.snapshotId }), 'amendment snapshot');
  equal(after.previous, before.id, 'amendment retains previous immutable snapshot');
  check(after.terms.revision !== before.terms.revision, 'new amendment uses current native terms');
  equal(value(await runtime.request(buyer, 'snapshot', { id: before.id }), 'original after amendment'), before, 'amendment preserves original');
}
