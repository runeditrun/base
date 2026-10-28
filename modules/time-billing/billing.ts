import type { BillingPacket, CancelInput, CommitInput, EntryWrite, NativeLine, PacketLine, PrepareInput, RatedTime, SourceClaim, Sql, TimeEntry } from './types.ts';
import type { Environment, Prepared } from './store.ts';
import { authorize, command, fence, guard, load } from './store.ts';
import { entryResource, nativeEntry } from './entries.ts';
import { canonical, digest, identifier, json, ref, sql } from './encoding.ts';
import { demand, LIMITS } from './errors.ts';
import { rateTime, validateRate } from './arithmetic.ts';
export const packetResource = (p: BillingPacket) => ({ subject: p.id, work: p.destination });
const currentSource = (env: Environment, entry: TimeEntry): Sql => sql("NOT EXISTS(SELECT 1 FROM tb_entries WHERE installation=? AND json_extract(body,'$.corrects')=?)", env.ctx.installationId, entry.id);
export async function priced(env: Environment, entry: TimeEntry): Promise<Prepared<RatedTime>> {
  demand(!entry.restored, 'locked', 'restored history is inert');
  demand(entry.state === 'approved' && entry.billable, 'conflict', 'entry must be approved and billable');
  demand(entry.policy.billing, 'unsupported');
  let rate = entry.rate;
  const queries = [guard(fence(env, 'tb_entries', entry.id, entry.revision)), guard(currentSource(env, entry))];
  if (entry.policy.rateStage === 'invoice') {
    const selected = await env.options.selectRate(env.ctx, entry, 'invoice'); validateRate(selected.rate); rate = selected.rate; queries.push(guard(selected.guard));
  }
  demand(rate, 'conflict', 'required historical rate missing');
  const result = rateTime(entry, rate), fingerprint = await digest(json(result));
  queries.push(sql('INSERT OR IGNORE INTO tb_ratings(installation,entry_id,revision,fingerprint,body) VALUES(?,?,?,?,?)', env.ctx.installationId, entry.id, entry.revision, fingerprint, json(result)));
  return { result, queries };
}
export async function rate(env: Environment, input: EntryWrite): Promise<RatedTime> {
  const entry = await nativeEntry(env, input.id);
  return command(env, 'rate', entryResource(entry), input, true, async () => {
    demand(entry.revision === input.expectedRevision, 'conflict'); return priced(env, entry);
  });
}
function validateNative(line: NativeLine): void {
  demand(line.kind === 'native'); ref(line.source); identifier(line.source.revision);
  demand(typeof line.amountMinor === 'string' && /^-?\d+$/.test(line.amountMinor) && line.amountMinor.replace('-', '').length <= LIMITS.integerDigits);
  demand(typeof line.currency === 'string' && /^[A-Z]{3}$/.test(line.currency));
  identifier(line.calculation.engine); identifier(line.calculation.revision);
  demand(Object.keys(line.calculation.basis).length <= 24, 'capacity');
  for (const [k, v] of Object.entries(line.calculation.basis)) { identifier(k); demand(typeof v === 'string' && v.length <= 2048); }
}
export async function preparePacket(env: Environment, input: PrepareInput): Promise<BillingPacket> {
  identifier(input.id); ref(input.destination);
  return command(env, 'preparePacket', { subject: input.id, work: input.destination }, input, true, async () => {
    demand(input.expectedRevision === 0, 'conflict');
    demand(Array.isArray(input.entries) && (input.nativeLines === undefined || Array.isArray(input.nativeLines)));
    const count = input.entries.length + (input.nativeLines?.length ?? 0);
    demand(count > 0); demand(count <= LIMITS.packetLines, 'capacity');
    const queries: Sql[] = [], lines: PacketLine[] = [];
    for (const source of input.entries) {
      const e = await nativeEntry(env, source.id); demand(e.revision === source.revision, 'conflict');
      const authority = await authorize(env, 'preparePacket', entryResource(e), true); queries.push(guard(authority.predicate, 'authority'));
      const selected = await priced(env, e); lines.push(selected.result); queries.push(...selected.queries);
    }
    for (const line of input.nativeLines ?? []) {
      demand(env.options.nativeLineGuard, 'unsupported', 'native calculation adapter required'); validateNative(line);
      queries.push(guard(await env.options.nativeLineGuard(env.ctx, line), 'authority')); lines.push(structuredClone(line));
    }
    demand(new Set(lines.map(l => canonical({ kind: l.source.kind, id: l.source.id }))).size === lines.length, 'conflict', 'duplicate source entitlement');
    const currency = lines[0].currency; demand(lines.every(l => l.currency === currency), 'conflict', 'mixed currency');
    const totalMinor = lines.reduce((n, l) => n + BigInt(l.amountMinor), 0n).toString(); demand(totalMinor.replace('-', '').length <= LIMITS.integerDigits, 'capacity');
    const packet: BillingPacket = { id: input.id, revision: 1, destination: input.destination, currency, lines, totalMinor, state: 'prepared', sourceFingerprint: await digest(json(lines)), artifact: null, attribution: env.ctx };
    queries.push(sql('INSERT INTO tb_packets(installation,id,work_kind,work_id,revision,body) VALUES(?,?,?,?,?,?)', env.ctx.installationId, packet.id, packet.destination.kind, packet.destination.id, 1, json(packet)));
    lines.forEach((line, ordinal) => queries.push(sql('INSERT INTO tb_packet_lines(installation,packet_id,ordinal,source_kind,source_id,source_revision,body) VALUES(?,?,?,?,?,?,?)', env.ctx.installationId, packet.id, ordinal, line.source.kind, line.source.id, line.source.revision, json(line))));
    return { result: packet, queries };
  });
}
export async function commitClaims(env: Environment, input: CommitInput): Promise<BillingPacket> {
  const old = await load<BillingPacket>(env, 'tb_packets', input.id);
  return command(env, 'commitClaims', packetResource(old), input, true, async () => {
    demand(!old.restored, 'locked', 'restored history is inert');
    demand(old.revision === input.expectedRevision && old.state === 'prepared', 'conflict');
    demand(input.artifact && input.artifact.bytes instanceof Uint8Array); demand(input.artifact.bytes.byteLength <= LIMITS.artifactBytes, 'capacity');
    demand(['text/csv', 'application/json', 'application/pdf'].includes(input.artifact.mediaType));
    demand(await digest(json(old.lines)) === old.sourceFingerprint, 'custody');
    const queries: Sql[] = [guard(fence(env, 'tb_packets', old.id, old.revision))];
    for (const line of old.lines) {
      if (line.kind === 'time') {
        const entry = await nativeEntry(env, line.entryId);
        const a = await authorize(env, 'commitClaims', entryResource(entry), true); queries.push(guard(a.predicate, 'authority'));
        demand(entry.revision === line.entryRevision, 'conflict');
        queries.push(guard(fence(env, 'tb_entries', entry.id, line.entryRevision)), guard(currentSource(env, entry)));
      } else {
        demand(env.options.nativeLineGuard, 'unsupported'); queries.push(guard(await env.options.nativeLineGuard(env.ctx, line), 'authority'));
      }
      const claim: SourceClaim = { source: line.source, destination: old.destination, packetId: old.id, state: 'claimed', revision: 1 };
      queries.push(sql('INSERT INTO tb_claims(installation,source_kind,source_id,source_revision,packet_id,revision,state,body) VALUES(?,?,?,?,?,?,?,?)', env.ctx.installationId, line.source.kind, line.source.id, line.source.revision, old.id, 1, 'claimed', json(claim)));
    }
    const bytes = input.artifact.bytes, hash = await digest(bytes);
    const artifact = { id: `artifact:${old.id}`, digest: hash, mediaType: input.artifact.mediaType, byteLength: bytes.length, custody: 'd1' as const };
    // D1 custody and native commitment share this transaction, including bytes.
    queries.push(sql('INSERT INTO tb_artifacts(installation,id,packet_id,digest,media_type,byte_length,bytes) VALUES(?,?,?,?,?,?,?)', env.ctx.installationId, artifact.id, old.id, hash, artifact.mediaType, bytes.length, bytes.slice().buffer));
    const packet: BillingPacket = { ...old, revision: old.revision + 1, state: 'approved', artifact };
    queries.push(sql('UPDATE tb_packets SET revision=?,body=? WHERE installation=? AND id=? AND revision=?', packet.revision, json(packet), env.ctx.installationId, packet.id, old.revision));
    return { result: packet, queries };
  });
}
export async function cancelClaims(env: Environment, input: CancelInput): Promise<BillingPacket> {
  const old = await load<BillingPacket>(env, 'tb_packets', input.id);
  return command(env, 'cancelClaims', packetResource(old), input, true, async () => {
    demand(!old.restored, 'locked', 'restored history is inert');
    demand(old.revision === input.expectedRevision && old.state !== 'cancelled', 'conflict'); demand(typeof input.reason === 'string' && input.reason.length > 0 && input.reason.length <= 2048);
    const rows = await env.options.database.prepare('SELECT body FROM tb_claims WHERE installation=? AND packet_id=?').bind(env.ctx.installationId, old.id).all<{body: string}>();
    const queries = [guard(fence(env, 'tb_packets', old.id, old.revision))];
    for (const row of rows.results) {
      const oldClaim = JSON.parse(row.body) as SourceClaim; demand(oldClaim.state === 'claimed', 'conflict');
      const claim: SourceClaim = { ...oldClaim, revision: oldClaim.revision + 1, state: 'released' };
      queries.push(sql("UPDATE tb_claims SET state='released',revision=?,body=? WHERE installation=? AND packet_id=? AND source_kind=? AND source_id=? AND revision=?", claim.revision, json(claim), env.ctx.installationId, old.id, claim.source.kind, claim.source.id, oldClaim.revision));
    }
    const packet: BillingPacket = { ...old, state: 'cancelled', revision: old.revision + 1 };
    queries.push(sql('UPDATE tb_packets SET revision=?,body=? WHERE installation=? AND id=? AND revision=?', packet.revision, json(packet), env.ctx.installationId, old.id, old.revision));
    return { result: packet, queries };
  });
}
