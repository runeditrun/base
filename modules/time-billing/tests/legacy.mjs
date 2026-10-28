import { createHash } from 'node:crypto';
const work = { kind: 'project', id: 'project-1' };
const source = { kind: 'legacy-timesheet', id: 'timesheet-row-7', revision: 'old-3' };
const attribution = { installationId: 'source', personId: 'legacy-preparer', agentId: 'retired-agent', sponsorId: 'legacy-preparer' };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function legacyFixture(policy) {
  const bytes = new TextEncoder().encode('invoice,currency,minor\r\nINV-OLD-7,AUD,27183\r\n');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const entry = { kind: 'legacy', id: 'legacy-entry', revision: 3, work, source, duration: null, state: 'posted', amountMinor: '27183', currency: 'AUD', unknown: ['observed-duration', 'rate-basis', 'reviewer'], historical: { nativeId: 'timesheet-row-7', invoiceNumber: 'INV-OLD-7', postedAt: '2020-04-05T03:00:00.000Z', originalCurrency: 'AUD', legacyHours: '1.375', exportedBy: attribution }, locked: true };
  const line = { kind: 'native', source, amountMinor: '27183', currency: 'AUD', calculation: { engine: 'legacy-priced', revision: 'old-3', basis: { nativeRow: 'timesheet-row-7', unknownRate: 'not retained' } } };
  const packet = { id: 'legacy-packet', revision: 4, destination: work, currency: 'AUD', lines: [line], totalMinor: '27183', state: 'approved', sourceFingerprint: createHash('sha256').update(canonical([line])).digest('hex'), artifact: { id: 'legacy-artifact', digest, mediaType: 'text/csv', byteLength: bytes.byteLength, custody: 'd1' }, attribution };
  const claim = { source, destination: work, packetId: packet.id, state: 'claimed', revision: 1 };
  const timer = { id: 'legacy-stopped-timer', revision: 2, work, timekeeperId: 'worker', preparerId: 'legacy-preparer', startedAt: '2020-04-04T23:00:00.000Z', stoppedAt: '2020-04-05T00:00:00.000Z', state: 'stopped', policy, timezone: 'Australia/Sydney', category: 'service', billable: true, source: { kind: 'legacy-timer', id: 'old-clock-2', revision: '2' }, entryId: null, attribution };
  return { entry, packet, claim, timer, bytes, digest };
}

export async function populateLegacy(db, policy) {
  const fixture = legacyFixture(policy);
  await db.prepare('INSERT INTO native_legacy_time(installation,id,entry_body,packet_body,claim_body,timer_body,artifact_bytes,artifact_digest) VALUES(?,?,?,?,?,?,?,?)').bind('source', fixture.entry.id, JSON.stringify(fixture.entry), JSON.stringify(fixture.packet), JSON.stringify(fixture.claim), JSON.stringify(fixture.timer), fixture.bytes, fixture.digest).run();
}
