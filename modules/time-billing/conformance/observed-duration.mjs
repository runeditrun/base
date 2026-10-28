import { check, equal, rejects, input, record, write, approve, OTHER, duration } from './assert.mjs';

export async function observedDuration(r, p) {
  const request = { ...await input(r, p, 'observed'), ...write('observed') };
  const entry = await r.command('recordEntry', request);
  equal(entry.duration, request.duration, 'original precision and date basis survive capture');
  equal(entry.preparerId, 'preparer', 'server authenticated preparer');
  equal(entry.timekeeperId, 'worker', 'native worker remains distinct');
  equal(entry.state, p.review ? 'draft' : 'approved', 'native capture profile state');
  const committed = await r.nativeState();
  equal(await r.command('recordEntry', request), entry, 'identical operation recovers its exact result');
  equal(await r.nativeState(), committed, 'replay does not repeat native outcomes');
  await rejects(() => r.command('recordEntry', { ...request, billable: false }), 'conflict');
  await rejects(() => r.command('recordEntry', { ...request, context: { personId: 'finance' } }, 'outsider'), 'forbidden');
  await rejects(() => r.readEntry(entry.id, 'outsider'), 'forbidden');
  await rejects(() => r.command('recordEntry', { ...request, id: 'scope-escape', work: OTHER, operationKey: 'scope-escape' }), 'forbidden');
  const beforeReads = await r.nativeState();
  for (let n = 0; n < 2; n++) await r.readEntry(entry.id);
  equal(await r.nativeState(), beforeReads, 'ordinary reads do not mutate domain or native rows');
  const timeView = await r.readEntry(entry.id, 'timeOnly');
  equal(timeView.entry.rate, null, 'time role cannot read private rate snapshots');
  await rejects(() => r.command('rate', write(entry.id, entry.revision, 'private-rate'), 'timeOnly'), 'forbidden');
  await r.membership('preparer', { active: false });
  await rejects(() => r.command('recordEntry', request), 'forbidden');
  await rejects(() => r.readEntry(entry.id), 'forbidden');
  await r.membership('preparer', { active: true });
  const bad = await input(r, p, 'bad-duration', { duration: duration('-1', '-1', 'ms') });
  await rejects(() => r.command('recordEntry', { ...bad, ...write(bad.id) }), 'invalid');
  const mismatched = await input(r, p, 'mismatched-duration', { duration: duration('36001') });
  await rejects(() => r.command('recordEntry', { ...mismatched, ...write(mismatched.id) }), 'invalid');
  const agent = await record(r, p, 'agent-attribution');
  const agentInput = await input(r, p, 'agent-entry');
  const attributed = await r.command('recordEntry', { ...agentInput, ...write(agentInput.id) }, 'agent');
  equal(attributed.attribution.agentId, 'agent-1', 'agent attribution survives native command');
  equal(attributed.attribution.sponsorId, 'preparer', 'agent retains its live sponsor');
  check(agent.id !== attributed.id, 'human and agent records keep separate identities');

  const timerInput = await input(r, p, 'dst-timer');
  const { duration: ignored, ...timer } = timerInput;
  const start = { ...timer, timezone: 'America/New_York', ...write(timer.id) };
  if (!p.timer) { await rejects(() => r.command('startTimer', start), 'unsupported'); return; }
  await r.clock('2026-11-01T05:59:59.500Z');
  const running = await r.command('startTimer', { ...start, startedAt: '1999-01-01T00:00:00Z' });
  equal(running.startedAt, '2026-11-01T05:59:59.500Z', 'trusted clock ignores request timestamps');
  const overlapping = await input(r, p, 'overlap');
  const { duration: omitted, ...overlap } = overlapping;
  await rejects(() => r.command('startTimer', { ...overlap, timezone: 'America/New_York', ...write(overlap.id) }), 'conflict');
  await r.clock('2026-11-01T06:00:01.000Z');
  const stopped = await r.command('stopTimer', { ...write(running.id, running.revision, 'stop'), entryId: 'dst-entry' });
  equal(stopped.duration.milliseconds, '1500', 'DST clock rollback does not invent elapsed time');
  equal(stopped.duration.interval, { start: running.startedAt, end: '2026-11-01T06:00:01.000Z' }, 'exact UTC interval retained');
  equal(stopped.duration.workDate, '2026-11-01', 'declared local work date');
  equal(stopped.duration.timezone, 'America/New_York', 'original zone retained');
  if (p.billing) {
    const approvedTimer = await approve(r, p, stopped);
    const timerRating = await r.command('rate', write(approvedTimer.id, approvedTimer.revision, 'timer-rating'), 'finance');
    equal(timerRating.observedMs, '1500', 'observed timer milliseconds remain exact at rating');
    equal(timerRating.capturedMs, '2000', 'half-second capture boundary rounds upward');
  }
  const afterStop = await r.nativeState();
  await r.restart();
  equal((await r.readEntry(stopped.id)).entry.duration, stopped.duration, 'restart preserves observed timer precision');
  equal(await r.nativeState(), afterStop, 'restart never resumes stopped work');
}
