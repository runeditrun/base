import type { BillingPacket, EntryRecord, EntryView, PacketView, Review, SourceClaim } from './types.ts';
import type { Environment } from './store.ts';
import { authorize, authorizedRows, load, statement } from './store.ts';
import { entryResource } from './entries.ts';
import { packetResource } from './billing.ts';
import { digest, sql } from './encoding.ts';
import { demand } from './errors.ts';
import { projectEntry } from './projection.ts';
export async function readEntry(env: Environment, id: string): Promise<EntryView> {
  const entry = await load<EntryRecord>(env, 'tb_entries', id), a = await authorize(env, 'readEntry', entryResource(entry));
  const rows = await authorizedRows<{body: string}>(env, a, sql('SELECT body FROM tb_entries WHERE installation=? AND id=?', env.ctx.installationId, id)); demand(rows.length, 'not_found');
  const reviews = await authorizedRows<{body: string}>(env, a, sql('SELECT body FROM tb_reviews WHERE installation=? AND entry_id=? ORDER BY revision', env.ctx.installationId, id));
  return { entry: projectEntry(JSON.parse(rows[0].body) as EntryRecord, a.projection), reviews: reviews.map(r => JSON.parse(r.body) as Review) };
}
export async function readPacket(env: Environment, id: string): Promise<PacketView> {
  const initial = await load<BillingPacket>(env, 'tb_packets', id), a = await authorize(env, 'readPacket', packetResource(initial), true);
  // Snapshot packet, claims and custody in the same read transaction.
  const results = await env.options.database.batch([
    statement(env.options.database, sql(`SELECT CASE WHEN (${a.predicate.sql}) THEN 1 ELSE 0 END AS ok`, ...a.predicate.params ?? [])),
    statement(env.options.database, sql('SELECT body FROM tb_packets WHERE installation=? AND id=?', env.ctx.installationId, id)),
    statement(env.options.database, sql('SELECT body FROM tb_claims WHERE installation=? AND packet_id=? ORDER BY source_kind,source_id', env.ctx.installationId, id)),
    statement(env.options.database, sql('SELECT id,digest,media_type,byte_length,bytes FROM tb_artifacts WHERE installation=? AND packet_id=?', env.ctx.installationId, id)),
  ]);
  demand((results[0].results[0] as {ok:number})?.ok === 1, 'forbidden');
  const row = results[1].results[0] as {body:string} | undefined; demand(row, 'not_found');
  const packet = JSON.parse(row.body) as BillingPacket;
  const claims = (results[2].results as {body:string}[]).map(r => JSON.parse(r.body) as SourceClaim);
  let artifact: PacketView['artifact'] = null;
  if (packet.artifact) {
    const held = results[3].results[0] as {id:string;digest:string;media_type:string;byte_length:number;bytes: number[] | ArrayBuffer} | undefined;
    demand(held, 'custody'); const bytes = new Uint8Array(held.bytes);
    demand(held.id === packet.artifact.id && held.digest === packet.artifact.digest && held.media_type === packet.artifact.mediaType && held.byte_length === bytes.length && bytes.length === packet.artifact.byteLength && await digest(bytes) === packet.artifact.digest, 'custody');
    artifact = { ref: packet.artifact, bytes };
  } else demand(!results[3].results.length, 'custody');
  return { packet, claims, artifact };
}
