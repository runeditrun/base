import { boundedJson, canonical, limits, sha256 } from './encoding.ts';
import { requireThat } from './errors.ts';
import { and, sql, Store } from './store.ts';
import { artifact } from './validation.ts';
import type { ArtifactRef, SigningDefinition, Sql } from './types.ts';
export function referenceKey(ref: ArtifactRef): string { return ref.id + '\0' + ref.version; }
export function references(def: SigningDefinition): ArtifactRef[] {
  return unique([...def.documents, ...def.consents.map(consent => consent.wording)]);
}
export function unique(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const map = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    artifact(ref);
    const prior = map.get(referenceKey(ref));
    requireThat(!prior || canonical(prior) === canonical(ref), 'artifact_mismatch'); map.set(referenceKey(ref), ref);
  }
  requireThat(map.size <= limits.artifacts, 'capacity');
  return [...map.values()];
}
export async function bytes(store: Store, reference: ArtifactRef): Promise<Uint8Array> {
  artifact(reference);
  const value = await store.options.artifacts.read(reference);
  requireThat(value, 'artifact_missing');
  requireThat(value.byteLength === reference.size && await sha256(value) === reference.sha256, 'artifact_mismatch');
  return value;
}
export async function verifyReferences(store: Store, refs: readonly ArtifactRef[]): Promise<void> {
  const all = unique(refs);
  requireThat(all.reduce((sum, ref) => sum + ref.size, 0) <= limits.bundleBytes, 'capacity');
  await Promise.all(all.map(ref => bytes(store, ref)));
}
export function retain(requestId: string, refs: readonly ArtifactRef[], intentId: string): Sql[] {
  return unique(refs).map(ref => sql("INSERT INTO as_artifacts(request_id,artifact_id,version,reference_json,phase,intent_id) VALUES(?,?,?,?,'retained',?)", requestId, ref.id, ref.version, boundedJson(ref), intentId));
}
/** Persist intent BEFORE any object put. Failed writes leave pending custody, never completion. */
export async function stage(store: Store, requestId: string, intentId: string, guard: Sql, uploads: readonly { reference: ArtifactRef; bytes: Uint8Array }[]): Promise<Sql[]> {
  requireThat(uploads.length > 0, 'artifact_missing'); requireThat(uploads.length <= limits.documents, 'capacity');
  unique(uploads.map(upload => upload.reference));
  for (const upload of uploads) {
    requireThat(upload.bytes instanceof Uint8Array);
    requireThat(upload.bytes.byteLength === upload.reference.size && await sha256(upload.bytes) === upload.reference.sha256, 'artifact_mismatch');
  }
  const pending: Sql[] = [];
  for (const { reference } of uploads) {
    pending.push(...store.assert(sql('NOT EXISTS(SELECT 1 FROM as_artifacts WHERE request_id=? AND artifact_id=? AND version=? AND reference_json<>?)', requestId, reference.id, reference.version, canonical(reference))));
    pending.push(sql("INSERT OR IGNORE INTO as_artifacts(request_id,artifact_id,version,reference_json,phase,intent_id) VALUES(?,?,?,?,'pending',?)", requestId, reference.id, reference.version, canonical(reference), intentId));
  }
  await store.batch([...store.assert(guard), ...pending,
    ...store.assert(sql('((SELECT COUNT(*) FROM as_artifacts WHERE request_id=?)<=?) AND ((SELECT COALESCE(SUM(json_extract(reference_json,\'$.size\')),0) FROM as_artifacts WHERE request_id=?)<=?)', requestId, limits.artifacts, requestId, limits.bundleBytes))]);
  await Promise.all(uploads.map(async ({ reference, bytes: value }) => {
    await store.options.artifacts.put(reference, value);
    await bytes(store, reference);
  }));
  return uploads.flatMap(({ reference }) => [
    ...store.assert(and(guard, sql('EXISTS(SELECT 1 FROM as_artifacts WHERE request_id=? AND artifact_id=? AND version=? AND reference_json=?)', requestId, reference.id, reference.version, canonical(reference)))),
    sql("UPDATE as_artifacts SET phase='retained' WHERE request_id=? AND artifact_id=? AND version=?", requestId, reference.id, reference.version),
  ]);
}
