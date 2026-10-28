import { check, equal, rejects, record, input, write, approve, duration, WORK } from './assert.mjs';

export async function ratingClaims(r, p) {
  let entry = await record(r, p, 'rated');
  entry = await approve(r, p, entry);
  if (!p.billing) {
    await rejects(() => r.command('rate', write(entry.id, entry.revision, 'rate'), 'finance'), 'unsupported');
    return;
  }
  await r.rate({ minorNumerator: '20000', durationMsDenominator: '3600000', revision: 'rate-2' });
  const beforeRate = await r.nativeState();
  const rated = await r.command('rate', write(entry.id, entry.revision, 'rate'), 'finance');
  equal(rated.observedMs, '36000', 'observed duration is separate from capture and billing');
  equal(rated.capturedMs, p.sample.capturedMs, 'declared capture rounding');
  equal(rated.billedMs, p.sample.billedMs, 'declared billing rounding');
  equal(rated.amountMinor, p.review ? p.sample.at12500 : p.sample.at20000, 'snapshot or current invoice rate chosen at the declared stage');
  equal(rated.currency, 'USD', 'exact result carries currency');
  equal(rated.rate.selectedAt, p.review ? 'approval' : 'invoice', 'rate selection stage retained');
  equal((await r.nativeState()).claims, beforeRate.claims, 'rating does not claim a source');
  await r.rate({ minorNumerator: '1', durationMsDenominator: (BigInt(p.sample.billedMs) * 2n).toString(), revision: 'half-cent' });
  const half = await approve(r, p, await record(r, p, 'half-cent'));
  const halfRated = await r.command('rate', write(half.id, half.revision, 'rate'), 'finance');
  equal(halfRated.amountMinor, '1', 'half cent rounds exactly upward without binary floating point');
  if (!p.timer) {
    const boundary = await record(r, p, 'half-minute', { duration: duration('30000', '0.5', 'minute') });
    const boundaryRated = await r.command('rate', write(boundary.id, boundary.revision, 'rate'), 'finance');
    equal(boundaryRated.capturedMs, '60000', 'manual half-minute capture rounds upward');
    equal(boundaryRated.observedMs, '30000', 'manual half-increment retains original observation');
  }
  await r.rate({ minorNumerator: '12500', durationMsDenominator: '3600000', revision: 'rate-3' });
  const readOnly = await r.nativeState();
  await r.readEntry(entry.id, 'finance');
  equal(await r.nativeState(), readOnly, 'viewing retained ratings never creates claims');
  const prepared = [];
  for (const id of ['packet-one', 'packet-two']) prepared.push(await r.command('preparePacket', { ...write(id), destination: WORK, entries: [{ id: entry.id, revision: entry.revision }] }, 'finance'));
  equal((await r.nativeState()).claims, readOnly.claims, 'two previews do not reserve billing entitlement');
  const bytes = new TextEncoder().encode('source,currency,amount\r\nrated,USD,retained\r\n');
  const commands = prepared.map(packet => ({ ...write(packet.id, packet.revision, 'commit'), artifact: { mediaType: 'text/csv', bytes } }));
  const race = await Promise.allSettled(commands.map(command => r.command('commitClaims', command, 'finance')));
  equal(race.filter(result => result.status === 'fulfilled').length, 1, 'only one concurrent destination claims a source');
  const losing = race.find(result => result.status === 'rejected');
  equal(losing.reason.code, 'conflict', 'source uniqueness is a transaction conflict');
  const winnerIndex = race.findIndex(result => result.status === 'fulfilled');
  const winner = race[winnerIndex].value;
  const loserIndex = 1 - winnerIndex;
  const view = await r.readPacket(winner.id, 'finance');
  equal([...view.artifact.bytes], [...bytes], 'approved artifact bytes have actual custody');
  equal(view.claims.filter(claim => claim.state === 'claimed').length, 1, 'winner retains exact source entitlement');
  const committed = await r.nativeState();
  equal(await r.command('commitClaims', commands[winnerIndex], 'finance'), winner, 'concurrent winner is replayable');
  equal(await r.nativeState(), committed, 'replay does not repeat native bill or outcome');
  await rejects(() => r.command('commitClaims', { ...commands[winnerIndex], artifact: { mediaType: 'text/csv', bytes: new TextEncoder().encode('changed') } }, 'finance'), 'conflict');
  await r.membership('finance', { active: false });
  await rejects(() => r.command('commitClaims', commands[winnerIndex], 'finance'), 'forbidden');
  await r.membership('finance', { active: true });
  const cancelled = await r.command('cancelClaims', { ...write(winner.id, winner.revision, 'cancel'), reason: 'Native invoice cancellation releases the source.' }, 'finance');
  equal(cancelled.state, 'cancelled', 'explicit native cancellation');
  equal((await r.readPacket(winner.id, 'finance')).claims[0].state, 'released', 'claim release is retained');
  const second = await r.command('commitClaims', { ...commands[loserIndex], operationKey: 'commit-after-release' }, 'finance');
  equal(second.state, 'approved', 'authorized cancellation makes entitlement available again');
  equal([...(await r.readPacket(winner.id, 'finance')).artifact.bytes], [...bytes], 'cancellation never rewrites approved evidence');
  const native = await r.nativeState();
  equal(native.activeBills, 1, 'native bill outcome commits and cancels in the same transaction');
  check(native.outcomes > 0, 'real native outcome rows exist');
  const doomed = await input(r, p, 'outcome-rollback');
  await r.outcomeFailure(true);
  await rejects(() => r.command('recordEntry', { ...doomed, ...write(doomed.id) }), 'storage');
  await r.outcomeFailure(false);
  equal(await r.nativeState(), native, 'native outcome failure rolls back the entire domain command');
  await rejects(() => r.readEntry(doomed.id), 'not_found');
  if (r.nativeAdjustment) {
    const adjustment = await r.nativeAdjustment();
    const mixed = { ...adjustment, currency: 'EUR' };
    await rejects(() => r.command('preparePacket', { ...write('mixed-currency'), destination: WORK, entries: [{ id: half.id, revision: half.revision }], nativeLines: [mixed] }, 'finance'), 'invalid');
    const costPlus = await r.command('preparePacket', { ...write('native-adjustment'), destination: WORK, entries: [], nativeLines: [adjustment] }, 'finance');
    equal(costPlus.lines[0], adjustment, 'native signed adjustment preserves its own calculation engine');
    equal(costPlus.totalMinor, adjustment.amountMinor, 'native line uses exact signed minor units');
  }
}
