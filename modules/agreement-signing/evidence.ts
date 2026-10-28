import { base64, boundedJson, canonical, limits, sha256, unbase64 } from './encoding.ts';
import { bytes, retain } from './custody.ts';
import { requireThat } from './errors.ts';
import { and, record, sql, Store } from './store.ts';
import { command, text } from './validation.ts';
import { bundleReferences, verify } from './verification.ts';
import type { CommandContext, EvidenceBundle, ExecutionRecord, LegacyRecord, ReadContext, RequestRecord, Sql } from './types.ts';
export async function evidence(store: Store, ctx: ReadContext, requestId: string): Promise<EvidenceBundle> {
  text(ctx.actorId); text(requestId); await store.authority(ctx);
  const row = await store.row(requestId);
  const [actions, events, executions] = await Promise.all([
    store.actions(requestId), store.events(requestId),
    store.rows<{ payload: string }>(sql('SELECT payload FROM as_external_executions WHERE request_id=? ORDER BY id', requestId)),
  ]);
  const bundle: EvidenceBundle = { format: 'agreement-signing/v1', request: record(row), actions, events,
    executions: executions.map(value => JSON.parse(value.payload) as ExecutionRecord), artifacts: [] };
  const refs = bundleReferences(bundle);
  requireThat(refs.reduce((sum, ref) => sum + ref.size, 0) <= limits.bundleBytes, 'capacity');
  bundle.artifacts = await Promise.all(refs.map(async reference => ({ reference, base64: base64(await bytes(store, reference)) })));
  await store.allowed(and(ctx.authority, sql('EXISTS(SELECT 1 FROM as_requests WHERE id=? AND revision=? AND root IS ?)', requestId, row.revision, row.root)));
  const result = await verify(bundle);
  requireThat(result.valid, 'artifact_mismatch');
  return bundle;
}
export async function restore(store: Store, ctx: CommandContext, bundle: EvidenceBundle): Promise<RequestRecord | LegacyRecord> {
  command(ctx); await store.authority(ctx);
  requireThat((await verify(bundle)).valid, 'artifact_mismatch');
  const payloadDigest = await sha256(canonical(bundle));
  const id = await store.commandId(ctx, 'restore');
  const previous = await store.first<{ payload_digest: string; result: string }>(sql("SELECT payload_digest,result FROM as_commands WHERE actor_id=? AND operation='restore' AND operation_key=?", ctx.actorId, ctx.operationKey));
  if (previous) { requireThat(previous.payload_digest === payloadDigest, 'replay_mismatch'); return JSON.parse(previous.result); }
  const request = { ...bundle.request, restored: true };
  requireThat(!await store.first(sql('SELECT id FROM as_requests WHERE id=?', request.id)), 'conflict');
  // Writes are explicit restore work; no provider/mail/identity callbacks or nativeCommit.
  // History is inserted only after every immutable object has been read back and verified.
  for (const entry of bundle.artifacts) {
    const existing = await store.options.artifacts.read(entry.reference);
    if (existing === null) await store.options.artifacts.put(entry.reference, unbase64(entry.base64));
    await bytes(store, entry.reference);
  }
  const native = request.recordKind === 'native';
  const source = native ? request.definition.source : request.source;
  const writes: Sql[] = [
    sql('INSERT INTO as_requests(id,record_kind,definition,legacy,state,revision,created_at,restored,root,completed_artifacts) VALUES(?,?,?,?,?,?,?,1,?,?)',
      request.id, request.recordKind, native ? boundedJson(request.definition) : null, native ? null : boundedJson(request), request.state, native ? request.revision : 1,
      request.createdAt, native ? request.root : null, native ? canonical(request.completedArtifacts) : '[]'),
    sql('INSERT INTO as_source_map(source_kind,source_id,source_revision,request_id) VALUES(?,?,?,?)', source.kind, source.id, source.revision, request.id),
    ...retain(request.id, bundleReferences(bundle), id),
  ];
  if (native) writes.push(
    ...request.definition.documents.map(ref => sql('INSERT INTO as_documents(request_id,document_id,reference_json) VALUES(?,?,?)', request.id, ref.id, canonical(ref))),
    ...request.definition.recipients.map(person => sql('INSERT INTO as_recipients(request_id,recipient_id,subject_id,participant) VALUES(?,?,?,?)', request.id, person.id, person.subjectId, canonical(person))),
    ...bundle.actions.map(action => sql('INSERT INTO as_actions(id,request_id,recipient_id,payload) VALUES(?,?,?,?)', action.id, request.id, action.recipientId, boundedJson(action))),
    ...bundle.events.map(event => sql('INSERT INTO as_events(request_id,sequence,digest,previous,payload) VALUES(?,?,?,?,?)', request.id, event.sequence, event.digest, event.previous, boundedJson(event.payload))),
    ...bundle.executions.map(execution => sql('INSERT INTO as_external_executions(id,request_id,provider,provider_request_id,payload) VALUES(?,?,?,?,?)', execution.id, request.id, execution.provider, execution.providerRequestId, boundedJson(execution))),
  );
  // D1 batch is atomic across chunks/statements; the capacity contract bounds the archive.
  writes.push(sql("INSERT INTO as_commands(id,actor_id,operation,operation_key,payload_digest,request_id,result,sealed,guard) VALUES(?,?,'restore',?,?,?,?,0,1)", id, ctx.actorId, ctx.operationKey, payloadDigest, request.id, boundedJson(request)));
  try { await store.batch([...store.assert(ctx.authority), ...writes, ...store.assert(ctx.authority)]); }
  catch (error) {
    const recovered = await store.first<{ payload_digest: string; result: string }>(sql('SELECT payload_digest,result FROM as_commands WHERE id=?', id));
    if (recovered) { await store.authority(ctx); requireThat(recovered.payload_digest === payloadDigest, 'replay_mismatch'); return JSON.parse(recovered.result); }
    throw error;
  }
  return request;
}
