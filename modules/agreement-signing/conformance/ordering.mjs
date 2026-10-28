import { check, equal, success, refused, command, evidence, current, review, sign, redemption } from './helpers.mjs';

export async function orderingConcurrentRedemption(runtime) {
  const prepared = await success(command(runtime, 'prepare', { sourceId: runtime.fixture.sourceId, replaces: null }, 'owner', 'prepare-replay'));
  equal(await success(command(runtime, 'prepare', { sourceId: runtime.fixture.sourceId, replaces: null }, 'owner', 'prepare-replay')), prepared, 'Same prepare command recovers the same request');
  const issued = await success(command(runtime, 'issue', { id: prepared.id, revision: prepared.revision }, 'owner', 'issue-replay'));
  equal(await success(command(runtime, 'issue', { id: prepared.id, revision: prepared.revision }, 'owner', 'issue-replay')), issued, 'Authorized issue replay recovers identical invitations');
  await refused((await review(runtime, issued, 2)).result, ['ordering']);

  const firstReview = await review(runtime, issued, 0, { key: 'review-replay' });
  const first = await success(firstReview.result);
  equal(await success(command(runtime, 'review', firstReview.input, runtime.fixture.participants[0].actor, 'review-replay')), first, 'Review replay recovers its single secret');
  const second = await success((await review(runtime, issued, 1)).result);
  const input = redemption(issued, first);
  const actor = runtime.fixture.participants[0].actor;
  const concurrent = await Promise.all([
    command(runtime, 'sign', input, actor, 'one-personal-act'),
    command(runtime, 'sign', input, actor, 'one-personal-act'),
    command(runtime, 'sign', redemption(issued, second), runtime.fixture.participants[1].actor, 'parallel-personal-act'),
  ]);
  const results = await Promise.all(concurrent.map(success));
  equal(results[0].action.id, results[1].action.id, 'Concurrent identical command returns one act');
  await refused(command(runtime, 'sign', { ...input, signableDigest: 'a'.repeat(64) }, actor, 'one-personal-act'), ['replay_mismatch']);
  await refused(command(runtime, 'sign', input, actor, 'different-personal-act'));
  check(results[2].request.state !== 'completed', 'Equal-order acts do not skip a required later participant');
  const beforeFinal = await evidence(runtime, issued.request.id);
  equal(beforeFinal.actions.length, 2, 'Two equal-order participants retain separate immutable acts');
  const finished = await sign(runtime, issued, 2);
  equal(finished.request.state, 'completed', 'Later participant proceeds after all earlier required acts');
  const final = await evidence(runtime, issued.request.id);
  equal(final.actions.filter(action => beforeFinal.actions.some(prior => prior.id === action.id)), beforeFinal.actions, 'Countersigning preserves earlier content and receipts');
  const native = await success(runtime.nativeState());
  equal(native.actions.length, 3, 'Concurrent redemption creates no duplicate native effects');
  equal(native.completions.length, 1, 'Concurrent completion creates one native outcome');
  equal((await success(command(runtime, 'verify', { bundle: final }))).valid, true, 'Concurrent history retains a coherent audit chain');
  await runtime.revoke(actor);
  await refused(command(runtime, 'sign', input, actor, 'one-personal-act'));
  check((await current(runtime, issued.request.id)).state === 'completed', 'Revoked replay cannot disturb completed history');
}
