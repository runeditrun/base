import { check, equal, rejects, record, approve, input, write, WORK } from './assert.mjs';

export async function upgradeRestore(r, p) {
  await r.legacyWrite();
  const legacy = await r.legacyRead();
  check(legacy.entry.id && legacy.packet.id, 'populated native legacy records are readable before upgrade');
  await r.upgrade();
  await r.restart();
  const retained = await r.readEntry(legacy.entry.id, 'finance');
  equal(retained.entry, legacy.entry, 'numbered backfill retains exact historical entry facts');
  equal(retained.entry.currency, 'AUD', 'historical currency is never rewritten to current billing currency');
  check(retained.entry.unknown.length > 0, 'missing historical facts stay explicitly unknown');
  const oldPacket = await r.readPacket(legacy.packet.id, 'finance');
  equal(oldPacket.packet, legacy.packet, 'issued historical packet identity and totals survive cutover');
  equal([...oldPacket.artifact.bytes], [...legacy.bytes], 'historical artifact bytes survive numbered backfill');
  equal(oldPacket.claims, legacy.claims, 'historical source ties survive cutover');
  await rejects(() => r.legacyWrite(), 'conflict');
  const redacted = (await r.readEntry(legacy.entry.id, 'timeOnly')).entry;
  equal(redacted.amountMinor, null, 'historical amount withheld from time-only role');
  equal(redacted.currency, null, 'historical currency withheld from time-only role');
  equal(redacted.historical, {}, 'private legacy payload withheld from time-only role');
  const current = await approve(r, p, await record(r, p, 'post-upgrade'));
  if (p.billing) await r.command('rate', write(current.id, current.revision, 'retained-rating'), 'finance');
  let inFlight;
  if (p.review) {
    const draft = await record(r, p, 'archive-submitted');
    inFlight = await r.command('submit', write(draft.id, draft.revision, 'submit'));
  }
  let running;
  if (p.timer) {
    const timerInput = await input(r, p, 'archive-running');
    const { duration, ...timer } = timerInput;
    running = await r.command('startTimer', { ...timer, timezone: 'Australia/Brisbane', ...write(timer.id) });
  }
  const beforeExport = await r.nativeState();
  const exported = await r.exportRecords(WORK, 'finance');
  equal(await r.nativeState(), beforeExport, 'export never writes or claims a source');
  equal(exported.manifest.entries.find(view => view.entry.id === legacy.entry.id).entry, legacy.entry, 'archive retains exact legacy entry');
  equal([...exported.manifest.packets.find(view => view.packet.id === legacy.packet.id).artifact.bytes], [...legacy.bytes], 'archive retains artifact custody');
  check(exported.manifest.entries.every(view => view.entry.work.id === WORK.id), 'export stays within native work scope');
  await rejects(() => r.exportRecords(WORK, 'timeOnly'), 'forbidden');
  await rejects(() => r.exportRecords(WORK, 'outsider'), 'forbidden');
  await r.target('restored');
  await rejects(() => r.command('restoreRecords', { operationKey: 'restore-tampered', expectedRevision: 0, archive: { ...exported.manifest, exportedAt: '2000-01-01T00:00:00Z' } }, 'finance', 'restored'), 'custody');
  await r.command('restoreRecords', { operationKey: 'restore', expectedRevision: 0, archive: exported.manifest }, 'finance', 'restored');
  const restored = await r.readEntry(current.id, 'finance', 'restored');
  equal(restored.entry.duration, current.duration, 'restore retains exact current duration');
  equal(restored.entry.attribution, current.attribution, 'restore retains original person and agent attribution');
  equal(restored.entry.locked, true, 'restored entries cannot resume approval or correction authority');
  const restoredPacket = await r.readPacket(legacy.packet.id, 'finance', 'restored');
  equal(restoredPacket.packet.id, legacy.packet.id, 'restore keeps issued packet IDs');
  equal([...restoredPacket.artifact.bytes], [...legacy.bytes], 'restore preserves approved bytes');
  equal(restoredPacket.claims, legacy.claims, 'restore preserves historical claims');
  const archive = (await r.exportRecords(WORK, 'finance', 'restored')).manifest;
  equal(archive.history.revisions, exported.manifest.history.revisions, 'all original revision snapshots remain exact');
  equal(archive.history.ratings, exported.manifest.history.ratings, 'all retained exact rating results survive restore');
  if (inFlight) {
    const inertReview = (await r.readEntry(inFlight.id, 'finance', 'restored')).entry;
    equal(inertReview.state, 'returned', 'in-flight review does not resume on restore');
    equal(inertReview.locked, true, 'restored in-flight review has no live mutation authority');
  }
  check(archive.timers.every(timer => timer.state === 'inert'), 'all restored clocks are inert');
  if (running) {
    const inert = archive.timers.find(timer => timer.id === running.id);
    equal(inert.state, 'inert', 'a running source clock never resumes');
    await rejects(() => r.command('stopTimer', { ...write(inert.id, inert.revision, 'resume-restored'), entryId: 'invented-after-restore' }, 'preparer', 'restored'), 'conflict');
  }
  const restoredNative = await r.nativeState('restored');
  equal(restoredNative.commands, 1, 'only explicit restore command exists; source operation keys are not imported');
  equal(restoredNative.outcomes, 0, 'restored history never replays native accounting outcomes');
  for (const event of exported.manifest.events) equal(archive.events.filter(copy => copy.body === event.body).length, 1, 'original outcome evidence survives once');
  await rejects(() => r.command('restoreRecords', { operationKey: 'restore-again', expectedRevision: 0, archive: exported.manifest }, 'finance', 'restored'), 'conflict');
  const attempted = await input(r, p, 'restore-correction');
  await rejects(() => r.command('correct', { ...write(current.id, restored.entry.revision, 'change-restored'), replacement: attempted, reason: 'Restored history is inert.' }, 'preparer', 'restored'), 'locked');
}
