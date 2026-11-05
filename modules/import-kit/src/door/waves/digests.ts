import { createHash } from 'node:crypto';
import type { D1Database } from '../../d1/types.ts';
import { canonicalHash } from '../../provenance/canonical-stream.ts';
import type { WaveAlias, WaveNativeRow } from './types.ts';

export interface WaveInventoryMember {type: string; identity: string; digest: string}
export const inventoryMember = (type: string, identity: unknown, content: unknown): WaveInventoryMember => ({
  type,identity:canonicalHash(identity),digest:canonicalHash([type,identity,content]),
});
export interface WaveInventoryInput {
  source: readonly {kind:string;sourceId:string;payloadHash:string}[];
  native: readonly WaveNativeRow[];
  aliases?: readonly WaveAlias[];
  files: readonly {path:string;sha256:string;bytes:number;role:'source'|'object'|'context';logicalBytes:number}[];
}
/** Adapter convenience for a complete independently enumerated census. An
 * edition can equivalently sort these digest leaves in its paged reader/store. */
export function waveInventoryHash(input: WaveInventoryInput): string {
  return canonicalHash([
    ...input.source.map(row=>inventoryMember('source',[row.kind,row.sourceId],row.payloadHash)),
    ...(input.aliases ?? []).map(alias=>inventoryMember('alias',[alias.kind,alias.sourceId],alias)),
    ...input.native.map(row=>inventoryMember('native',[row.table,row.key],row)),
    ...input.files.map(file=>inventoryMember('file',file.path,[file.sha256,file.bytes,file.role,file.logicalBytes])),
  ].map(row=>row.digest).sort());
}
/** Hash the complete exact inventory without materializing its JSON or all
 * source/native membership rows. The unique identity index seals coverage;
 * the digest index permits bounded keyset reads. */
export async function storedInventoryHash(db: D1Database, parentId: string): Promise<string> {
  const digest=createHash('sha256');digest.update('[');
  let after='',first=true;
  for (;;) {
    const {results}=await db.prepare('SELECT digest FROM ik_door_wave_members WHERE parent_id=? AND digest>? ORDER BY digest LIMIT 128').bind(parentId,after).all<{digest:string}>();
    for (const row of results) {digest.update((first?'':',')+JSON.stringify(row.digest));first=false;after=row.digest;}
    if(results.length<128)break;
  }
  digest.update(']');return digest.digest('hex');
}
