import { check, equal, success, refused, command, evidence, current, issue, review, sign, complete, redemption } from './helpers.mjs';

export async function exactSourceParticipant(runtime) {
  const issued = await issue(runtime);
  const { fixture } = runtime;
  equal(issued.request.definition.kind, fixture.definition.kind, 'Evidence kind retains the native profile');
  equal(issued.request.definition.documents, fixture.definition.documents, 'Preparation binds exact source bytes');
  equal(issued.request.definition.selectionDigest, fixture.definition.selectionDigest, 'Preparation binds the commercial selection');

  await refused((await review(runtime, issued, 0, { actor: 'outsider' })).result);
  await refused((await review(runtime, issued, 0, { actor: 'agent' })).result, ['unauthorized']);
  for (const binding of [{ approvalDigest: 'changed-approval' }, { selectionDigest: 'changed-selection' }, { documentIds: [] }, { consents: [] },
    { fields: { ...fixture.binding.fields, quantity: 99 } }]) {
    await refused((await review(runtime, issued, 0, { binding })).result);
  }
  const before = await evidence(runtime, issued.request.id);
  equal(before.actions.length, 0, 'Rejected identity or binding creates no personal act');

  const participant = fixture.participants[0];
  const reviewed = await success((await review(runtime, issued, 0)).result);
  const reviewedRequest = await current(runtime, issued.request.id);
  check(reviewedRequest.revision > issued.request.revision, 'Successful review advances the request revision');
  equal(reviewed.documents, fixture.definition.documents.filter(item => fixture.definition.recipients[0].documentIds.includes(item.id)), 'Review returns the exact permitted bytes');
  await runtime.rotateSession(participant.actor);
  await refused(command(runtime, 'sign', redemption(issued, reviewed), participant.actor));
  const first = await sign(runtime, issued, 0);
  equal(first.action.source, fixture.definition.source, 'Act retains native source identity and revision');
  equal(first.action.act, fixture.binding.act, 'Actual personal intent is retained');
  equal(first.action.consents.map(item => ({ purpose: item.purpose, wording: item.wording, language: item.language })), fixture.definition.consents, 'Consent records retain wording, version and language');
  check(first.action.consents.every(item => Boolean(item.acceptedAt)), 'Actual consent has an acceptance time');
  check(first.action.authentication === fixture.definition.recipients[0].authentication, 'Identity assurance is not upgraded');
  if (fixture.drawnSignature) {
    const act = { type: 'drawn-signature', name: 'Bob Participant', artifact: fixture.drawnSignature };
    const drawnReview = await success((await review(runtime, issued, 1, { binding: { act } })).result);
    const drawn = await success(command(runtime, 'sign', redemption(issued, drawnReview), fixture.participants[1].actor));
    equal(drawn.action.act, act, 'Drawn signature keeps its distinct original media reference');
  } else await sign(runtime, issued, 1);
  const completed = await sign(runtime, issued, 2);
  equal(completed.request.state, 'completed', 'Every required participant completes the request');
  const native = await success(runtime.nativeState());
  equal(native.actions.length, fixture.participants.length, 'Native effects join the personal acts');
  equal(native.completions.length, 1, 'Completion publishes once to the native business outcome');

  await runtime.reviseSource();
  const stale = await issue(runtime);
  const staleReview = await success((await review(runtime, stale, 0)).result);
  await runtime.reviseSource();
  await refused(command(runtime, 'sign', redemption(stale, staleReview), participant.actor), ['stale', 'conflict', 'unauthorized']);
  equal((await evidence(runtime, stale.request.id)).actions.length, 0, 'A changed native source cannot acquire an old signature');
  const fresh = await issue(runtime);
  const final = await complete(runtime, fresh);
  equal(final.action.source, (await current(runtime, fresh.request.id)).definition.source, 'A newly prepared source uses its current revision');
}
