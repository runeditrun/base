import { join } from 'node:path';
import { buildPackage } from '../package-transfer.mjs';

/** Materialize checked HH lines and sidecars as immutable files, and reference
 * the already verified original blobs. The shared sender owns segmentation,
 * manifest probing and the resumable upload journal. */
export async function prepareZendeskPackage({ result, quota, directory, signal, mode = 'snapshot' }) {
 const files = [], store = result.store;
 const add = async (path, bytes) => {
  const ref = await store.put(bytes);
  files.push({ path, file: join(store.path, ref.file), bytes: ref.bytes, sha256: ref.sha256 });
 };
 let start = 0, position = 0, ordinal = 1;
 while (position < result.bytes.length) {
  signal?.throwIfAborted();
  const newline = result.bytes.indexOf(10, position);
  const end = newline < 0 ? result.bytes.length : newline + 1;
  if (position > start && end - start > 8 * 1024 * 1024) {
   await add(`records-${String(ordinal++).padStart(6,'0')}.ndjson`, result.bytes.subarray(start,position)); start = position;
  }
  position = end;
 }
 if (position > start) await add(`records-${String(ordinal).padStart(6,'0')}.ndjson`, result.bytes.subarray(start,position));
 for (const [path, bytes] of result.files) if (!path.startsWith('records-')) await add(path,bytes);
 for (const [path,ref] of result.blobs) { await store.get(ref); files.push({ path, file: join(store.path,ref.file), bytes: ref.bytes, sha256: ref.sha256 }); }
 return buildPackage({ files, quota, directory, signal, mode, source: result.source,
  records: { total: Object.values(result.census.records).reduce((a,b) => a+b,0), byKind: result.census.records }, totals: result.census });
}
