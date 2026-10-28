import type { Archive, BillingPacket, EntryRecord, ExportResult, PacketView, RatedTime, Review, SourceClaim, Sql, Timer, WorkRef, Write } from './types.ts';
import type { Environment } from './store.ts';
import { authorize, command, guard, statement } from './store.ts';
import { canonical, digest, identifier, json, ref, sql, utf8 } from './encoding.ts';
import { demand, LIMITS } from './errors.ts';
/** Verify retained bytes and archive content before handing them to portability/object custody. */
export async function verifyArchive(archive: Archive): Promise<void> {
  demand(archive?.format === 'time-billing/1'); ref(archive.work); identifier(archive.installationId);
  const { digest: expected, ...body } = archive;
  demand(typeof expected === 'string' && await digest(json(body)) === expected, 'custody', 'archive digest mismatch');
  const records = archive.entries.length + archive.timers.length + archive.packets.length + archive.history.revisions.length + archive.history.ratings.length + archive.events.length;
  demand(records <= LIMITS.exportRecords, 'capacity');
  for (const view of archive.packets) {
    demand(view.packet.lines.length <= LIMITS.packetLines, 'capacity');
    demand(await digest(json(view.packet.lines)) === view.packet.sourceFingerprint, 'custody');
    if (view.packet.artifact) {
      demand(view.artifact && canonical(view.artifact.ref) === canonical(view.packet.artifact), 'custody');
      const bytes = new Uint8Array(view.artifact.bytes);
      demand(bytes.length <= LIMITS.artifactBytes, 'capacity');
      demand(bytes.length === view.artifact.ref.byteLength && await digest(bytes) === view.artifact.ref.digest, 'custody');
    } else demand(view.artifact === null, 'custody');
  }
}
export async function exportRecords(env: Environment, work: WorkRef): Promise<ExportResult> {
  ref(work); const a = await authorize(env, 'exportRecords', { subject: `export:${work.id}`, work }, true);
  const args = [env.ctx.installationId, work.kind, work.id];
  const scoped = (table: string, extra = '') => sql(`SELECT * FROM ${table} WHERE installation=? AND work_kind=? AND work_id=? ${extra} LIMIT ${LIMITS.exportRecords + 1}`, ...args);
  const joined = (table: string, key: string, target: string) => sql(`SELECT r.* FROM ${table} r JOIN ${target} t ON t.installation=r.installation AND t.id=r.${key} WHERE t.installation=? AND t.work_kind=? AND t.work_id=? LIMIT ${LIMITS.exportRecords + 1}`, ...args);
  const result = await env.options.database.batch([
    statement(env.options.database, sql(`SELECT CASE WHEN (${a.predicate.sql}) THEN 1 ELSE 0 END AS ok`, ...a.predicate.params ?? [])),
    ...[scoped('tb_entries', 'ORDER BY id'), scoped('tb_timers', 'ORDER BY id'), scoped('tb_packets', 'ORDER BY id'),
      joined('tb_reviews', 'entry_id', 'tb_entries'), joined('tb_entry_revisions', 'entry_id', 'tb_entries'), joined('tb_ratings', 'entry_id', 'tb_entries'),
      joined('tb_claims', 'packet_id', 'tb_packets'), joined('tb_artifacts', 'packet_id', 'tb_packets'), scoped('tb_events', 'ORDER BY sequence')].map(q => statement(env.options.database, q)),
  ]);
  demand((result[0].results[0] as {ok:number})?.ok === 1, 'forbidden');
  demand(result.slice(1).every(r => r.results.length <= LIMITS.exportRecords), 'capacity');
  const bodies = <T>(i: number): T[] => (result[i].results as {body: string}[]).map(r => JSON.parse(r.body) as T);
  const reviews = bodies<Review>(4), claims = bodies<SourceClaim>(7);
  const packets: PacketView[] = bodies<BillingPacket>(3).map(packet => {
    const row = (result[8].results as {id:string;bytes:number[]}[]).find(r => r.id === packet.artifact?.id);
    return { packet, claims: claims.filter(c => c.packetId === packet.id), artifact: packet.artifact && row ? { ref: packet.artifact, bytes: new Uint8Array(row.bytes) } : null };
  });
  const body: Omit<Archive, 'digest'> = { format: 'time-billing/1', installationId: env.ctx.installationId, work, exportedAt: (env.options.now?.() ?? new Date()).toISOString(),
    entries: bodies<EntryRecord>(1).map(entry => ({ entry, reviews: reviews.filter(r => r.entryId === entry.id) })), timers: bodies<Timer>(2), packets,
    history: { revisions: (result[5].results as {entry_id:string;revision:number;body:string}[]).map(r => ({ entryId: r.entry_id, revision: r.revision, entry: JSON.parse(r.body) as EntryRecord })), ratings: bodies<RatedTime>(6) },
    events: (result[9].results as {sequence:number;body:string}[]).map(e => ({ sequence: e.sequence, body: e.body })),
  };
  const manifest: Archive = { ...body, digest: await digest(json(body)) }; await verifyArchive(manifest);
  return { manifest, bytes: utf8(json(manifest)) };
}
/** Explicit restore to an empty scope. A seed keeps this behind its native archive/maintenance door. */
export async function restoreRecords(env: Environment, input: Write & {archive: Archive}): Promise<{restored:true}> {
  await verifyArchive(input.archive); const archive = input.archive, i = env.ctx.installationId;
  return command(env, 'restoreRecords', { subject: `restore:${archive.work.id}`, work: archive.work }, input, true, async () => {
    demand(input.expectedRevision === 0, 'conflict');
    const queries: Sql[] = [guard(sql('NOT EXISTS(SELECT 1 FROM tb_entries WHERE installation=? AND work_kind=? AND work_id=?) AND NOT EXISTS(SELECT 1 FROM tb_packets WHERE installation=? AND work_kind=? AND work_id=?) AND NOT EXISTS(SELECT 1 FROM tb_timers WHERE installation=? AND work_kind=? AND work_id=?)', i, archive.work.kind, archive.work.id, i, archive.work.kind, archive.work.id, i, archive.work.kind, archive.work.id))];
    const entryIds = new Set(archive.entries.map(v => v.entry.id));
    demand(entryIds.size === archive.entries.length, 'custody');
    for (const view of archive.entries) {
      const e = view.entry; identifier(e.id); ref(e.source); identifier(e.source.revision);
      demand(canonical(e.work) === canonical(archive.work), 'custody');
      const restored = { ...e, locked: true, ...(e.kind === 'entry' ? { restored: true } : {}), ...(e.kind === 'entry' && e.state === 'submitted' ? { state: 'returned' } : {}) };
      queries.push(sql('INSERT INTO tb_entries(installation,id,work_kind,work_id,revision,body) VALUES(?,?,?,?,?,?)', i, e.id, e.work.kind, e.work.id, e.revision, json(restored)));
    }
    for (const revision of archive.history.revisions) {
      demand(entryIds.has(revision.entryId) && revision.entry.id === revision.entryId && revision.entry.revision === revision.revision, 'custody');
      queries.push(sql('INSERT INTO tb_entry_revisions(installation,entry_id,revision,body) VALUES(?,?,?,?)', i, revision.entryId, revision.revision, json(revision.entry)));
    }
    for (const view of archive.entries) {
      demand(archive.history.revisions.some(r => r.entryId === view.entry.id && r.revision === view.entry.revision), 'custody');
      for (const r of view.reviews) queries.push(sql('INSERT INTO tb_reviews(installation,entry_id,revision,body) VALUES(?,?,?,?)', i, r.entryId, r.revision, json(r)));
      const s = view.entry.source;
      queries.push(sql('INSERT INTO tb_source_map(installation,source_kind,source_id,source_revision,entry_id) VALUES(?,?,?,?,?)', i, s.kind, s.id, s.revision, view.entry.id));
    }
    for (const rating of archive.history.ratings) queries.push(sql('INSERT INTO tb_ratings(installation,entry_id,revision,fingerprint,body) VALUES(?,?,?,?,?)', i, rating.entryId, rating.entryRevision, await digest(json(rating)), json(rating)));
    for (const t of archive.timers) {
      demand(canonical(t.work) === canonical(archive.work), 'custody');
      const timer: Timer = { ...t, state: 'inert' };
      queries.push(sql('INSERT INTO tb_timers(installation,id,work_kind,work_id,person_id,overlap_key,revision,state,body) VALUES(?,?,?,?,?,NULL,?,?,?)', i, t.id, t.work.kind, t.work.id, t.timekeeperId, t.revision, 'inert', json(timer)));
    }
    for (const view of archive.packets) {
      const p: BillingPacket = { ...view.packet, restored: true }; demand(canonical(p.destination) === canonical(archive.work), 'custody');
      queries.push(sql('INSERT INTO tb_packets(installation,id,work_kind,work_id,revision,body) VALUES(?,?,?,?,?,?)', i, p.id, p.destination.kind, p.destination.id, p.revision, json(p)));
      p.lines.forEach((l, n) => queries.push(sql('INSERT INTO tb_packet_lines(installation,packet_id,ordinal,source_kind,source_id,source_revision,body) VALUES(?,?,?,?,?,?,?)', i, p.id, n, l.source.kind, l.source.id, l.source.revision, json(l))));
      for (const c of view.claims) { demand(c.packetId === p.id && p.lines.some(l => canonical(l.source) === canonical(c.source)), 'custody');
        queries.push(sql('INSERT INTO tb_claims(installation,source_kind,source_id,source_revision,packet_id,revision,state,body) VALUES(?,?,?,?,?,?,?,?)', i, c.source.kind, c.source.id, c.source.revision, c.packetId, c.revision, c.state, json(c))); }
      if (view.artifact) { const a = view.artifact.ref, bytes = new Uint8Array(view.artifact.bytes);
        queries.push(sql('INSERT INTO tb_artifacts(installation,id,packet_id,digest,media_type,byte_length,bytes) VALUES(?,?,?,?,?,?,?)', i, a.id, p.id, a.digest, a.mediaType, a.byteLength, bytes.slice().buffer)); }
    }
    for (const e of archive.events) queries.push(sql('INSERT INTO tb_events(installation,work_kind,work_id,body) VALUES(?,?,?,?)', i, archive.work.kind, archive.work.id, e.body));
    return { result: { restored: true as const }, queries };
  });
}
