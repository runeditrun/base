import { check, equal, success, refused, command, evidence, current, issue, review, sign, redemption, version } from './helpers.mjs';

export async function replacementWithdrawal(runtime) {
  const original = await issue(runtime);
  await sign(runtime, original, 0);
  const pending = await success((await review(runtime, original, 1)).result);
  const history = await evidence(runtime, original.request.id);
  await runtime.reviseSource();
  const replacement = await issue(runtime, original.request.id);
  equal(replacement.request.definition.replaces, original.request.id, 'Correction links to the previous request');
  await refused(command(runtime, 'sign', redemption(original, pending), runtime.fixture.participants[1].actor));
  await refused(command(runtime, 'issue', version(await current(runtime, original.request.id))));
  const preserved = await evidence(runtime, original.request.id);
  equal(preserved.actions, history.actions, 'Replacement preserves earlier personal acts');
  equal(preserved.artifacts, history.artifacts, 'Replacement preserves exact earlier evidence bytes');

  const replacementVersion = version(await current(runtime, replacement.request.id));
  const closures = replacement.request.definition.closures;
  const unsupported = ['declined', 'cancelled', 'withdrawn'].find(state => !closures.includes(state));
  if (unsupported) await refused(command(runtime, 'close', { request: replacementVersion, state: unsupported, reason: 'Unsupported native transition' }), ['unsupported']);
  const liveReview = await success((await review(runtime, replacement, 0)).result);
  const state = closures.includes('withdrawn') ? 'withdrawn' : closures[0];
  if (!state) {
    await refused(command(runtime, 'close', { request: version(await current(runtime, replacementVersion.id)), state: 'withdrawn', reason: 'Withdrawal unsupported' }), ['unsupported']);
    return; // Replacement and the separate real-expiry scenario still prove invalidation.
  }
  const closed = await success(command(runtime, 'close', { request: version(await current(runtime, replacementVersion.id)), state, reason: 'Native owner closed this pending agreement' }));
  equal(closed.state, state, 'The declared native closure closes the pending request');
  await refused(command(runtime, 'sign', redemption(replacement, liveReview), runtime.fixture.participants[0].actor));
  await refused((await review(runtime, replacement, 1)).result);
  equal((await success(runtime.nativeState())).completions.length, 0, 'Closure does not publish a completed native outcome');
}

export async function expiry(runtime) {
  const issued = await issue(runtime);
  const reviewed = await success((await review(runtime, issued, 0)).result);
  const expiryAt = Date.parse(issued.request.definition.expiresAt);
  check(Number.isFinite(expiryAt), 'Expiry fixture must declare a real expiry');
  const delay = Math.max(0, expiryAt - Date.now() + 1100);
  check(delay < 12000, 'Expiry fixture must expire promptly without changing the service clock');
  await new Promise(resolve => setTimeout(resolve, delay));
  await refused(command(runtime, 'sign', redemption(issued, reviewed), runtime.fixture.participants[0].actor), ['expired', 'closed']);
  await refused((await review(runtime, issued, 1)).result, ['expired', 'closed']);
  const expired = await success(command(runtime, 'close', { request: version(await current(runtime, issued.request.id)), state: 'expired', reason: 'Native expiry sweep' }));
  equal(expired.state, 'expired', 'Expiration can be recorded as an explicit terminal state');
  equal((await evidence(runtime, issued.request.id)).actions.length, 0, 'Expired authority cannot create a personal act');
}
