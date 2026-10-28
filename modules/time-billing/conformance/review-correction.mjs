import { check, equal, fingerprint, rejects, input, record, write, approve, duration } from './assert.mjs';

export async function reviewCorrection(r, p) {
  let original = await record(r, p, 'review-original');
  if (p.review) {
    const submitted = await r.command('submit', write(original.id, original.revision, 'submit'));
    const decision = { ...write(original.id, submitted.revision, 'approve'), decision: 'approve', reason: 'Checked native work.' };
    for (const actor of ['worker', 'preparer', 'agent']) await rejects(() => r.command('decide', decision, actor), 'forbidden');
    await r.reviewPolicy({ enabled: false, revision: 'review-2' });
    await rejects(() => r.command('decide', decision, 'reviewer'), 'forbidden');
    await r.reviewPolicy({ enabled: true, revision: 'review-3' });
    original = await r.command('decide', decision, 'reviewer');
    const approvedState = await r.nativeState();
    await r.reviewPolicy({ enabled: false, revision: 'review-revoked' });
    await rejects(() => r.command('decide', decision, 'reviewer'), 'conflict');
    equal(await r.nativeState(), approvedState, 'revoked review eligibility cannot recover or repeat a personal act');
    await r.reviewPolicy({ enabled: true, revision: 'review-current' });
    equal(await r.command('decide', decision, 'reviewer'), original, 'eligible review replay retains the original personal act');
    equal(await r.nativeState(), approvedState, 'eligible replay writes no new approval or native outcome');

    await rejects(() => r.command('decide', { ...decision, operationKey: 'stale-review' }, 'reviewer'), 'conflict');
    const history = (await r.readEntry(original.id)).reviews;
    const approval = history.find(review => review.decision === 'approve');
    check(approval?.contentDigest, 'approval binds the exact entry content');
    equal(approval.contentDigest, await fingerprint(original), 'approval digest binds duration, source, policy and selected rate');
    equal(approval.personId, 'reviewer', 'eligible native reviewer identity');
    equal(approval.policyRevision, 'review-3', 'current native review policy revision');
    if (p.billing) equal(original.rate.selectedAt, 'approval', 'reviewed profile freezes approval-time rate');
    equal((await r.readEntry(original.id, 'timeOnly')).entry.rate, null, 'approved private rate is redacted by current native projection');
  } else {
    equal((await r.readEntry(original.id)).reviews.length, 0, 'no fabricated submission or approval history');
    await rejects(() => r.command('submit', write(original.id, original.revision, 'unsupported-submit')), 'unsupported');
    await rejects(() => r.command('decide', { ...write(original.id, original.revision, 'unsupported-review'), decision: 'approve', reason: 'No review profile.' }, 'reviewer'), 'unsupported');
    equal(original.rate, null, 'invoice-time profile does not invent an earlier rate');
  }
  const replacementInput = await input(r, p, 'review-replacement', { duration: duration('72000', '0.02') });
  const corrected = await r.command('correct', { ...write(original.id, original.revision, 'correction'), replacement: replacementInput, reason: 'Correct observed duration with a linked record.' });
  equal(corrected.corrects, original.id, 'correction is additive and linked');
  equal((await r.readEntry(original.id, 'finance')).entry, original, 'approved original remains exact historical evidence');
  const approved = await approve(r, p, corrected);
  const locked = await r.command('lock', write(approved.id, approved.revision, 'lock'), 'finance');
  equal(locked.locked, true, 'native authorized period lock');
  const attempted = await input(r, p, 'locked-replacement');
  await rejects(() => r.command('correct', { ...write(locked.id, locked.revision, 'locked-correction'), replacement: attempted, reason: 'Cannot reopen locked period.' }), 'locked');
  await r.membership('finance', { active: false });
  await rejects(() => r.command('lock', write(approved.id, approved.revision, 'lock'), 'finance'), 'forbidden');
  await r.membership('finance', { active: true });
  equal((await r.readEntry(locked.id)).entry.locked, true, 'lock survives denied replay');
}
