import { makePart, ContentVerifier, ArchiveVerifier } from '../../modules/portability/format.mjs';
import { canonicalJson, sha256 } from '../../modules/portability/hash.mjs';

export const archiveRecords = text => text.trim().split('\n').map(JSON.parse);
export const archiveItems = records => records.filter(record => record.kind === 'part').flatMap(part => part.items);
export const archiveRows = (records, table) => archiveItems(records).filter(item => item.table === table).map(item => item.row);

// Keep deliberately changed archives internally valid so refusal reaches the
// public import policy rather than failing on an unrelated checksum.
export async function remakeArchive(records, { tables = records[0].tables, items = archiveItems(records), schema } = {}) {
 const manifest = { ...records[0], tables, schema: schema ?? await sha256(canonicalJson(tables.map(({ name, sql }) => ({ name, sql })))), partCount: Math.ceil(items.length / 100) };
 const parts = [];
 for (let index = 0; index < items.length; index += 100) parts.push(await makePart(parts.length, items.slice(index, index + 100)));
 const verifier = new ContentVerifier(manifest);
 for (const item of items) verifier.add(item);
 const integrity = new ArchiveVerifier(manifest);
 for (const part of parts) integrity.add(part);
 return [manifest, ...parts, { ...records.at(-1), partCount: parts.length, contentHash: verifier.digest(), archiveHash: integrity.digest() }];
}
