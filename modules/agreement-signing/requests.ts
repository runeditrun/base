import { boundedJson, canonical, limits, randomToken, sha256 } from './encoding.ts';
import { requireThat, SigningError } from './errors.ts';
import { references, retain, verifyReferences } from './custody.ts';
import { and, invalidate, sql, Store, unexpired } from './store.ts';
import { artifact, command, definition, object, text, timestamp, version } from './validation.ts';
import type { AuditEvent, CloseInput, CommandContext, ExecutionRecord, ExternalExecution, IssueResult, RequestRecord, SigningDefinition, Sql, VersionedId } from './types.ts';
export async function prepare(store: Store, ctx: CommandContext, input: SigningDefinition): Promise<RequestRecord> {
  command(ctx); definition(input);
  const def = JSON.parse(boundedJson(input)) as SigningDefinition;
  const recovered = await store.replay<RequestRecord>(ctx, 'prepare', def); if (recovered) return recovered;
  await store.authority(ctx);
  requireThat(def.completion !== 'artifacts-required' || !!store.options.finalize, 'unsupported');
  await verifyReferences(store, references(def));
  const request: RequestRecord = { recordKind: 'native', id: 'as_' + crypto.randomUUID(), revision: 1, definition: def,
    state: 'draft', createdAt: store.now(), restored: false, root: null, completedArtifacts: [] };
  const source = def.source;
  const guard = await store.source(ctx, request, 'prepare');
  const writes: Sql[] = [];
  if (def.replaces !== null) {
    const old = await store.request(def.replaces);
    requireThat(!old.restored, 'restored_inert');
    requireThat(old.definition.source.kind === source.kind && old.definition.source.id === source.id && old.definition.source.revision !== source.revision, 'stale');
    requireThat(['draft', 'issued', 'in-progress'].includes(old.state), 'closed');
    requireThat(old.revision < limits.events, 'capacity');
    const closure: AuditEvent['payload'] = { operation: 'close', actorId: ctx.actorId, agent: ctx.agent, at: store.now(), commandId: await store.commandId(ctx, 'prepare'),
      request: { ...old, state: 'cancelled', revision: old.revision + 1 }, action: null, execution: null, detail: { reason: 'replacement', replacedBy: request.id } };
    const digest = await sha256(canonical({ sequence: old.revision + 1, previous: old.root, algorithm: 'sha256-canonical-json-v1', payload: closure }));
    // The prior chain gains an explicit closure linked to the immutable successor.
    writes.push(...store.assert(and(ctx.authority, sql('EXISTS(SELECT 1 FROM as_requests WHERE id=? AND revision=? AND root IS ? AND state IN (\'draft\',\'issued\',\'in-progress\') AND restored=0)', old.id, old.revision, old.root))),
      sql("UPDATE as_requests SET state='cancelled',revision=?,root=? WHERE id=?", old.revision + 1, digest, old.id),
      sql('INSERT INTO as_events(request_id,sequence,digest,previous,payload) VALUES(?,?,?,?,?)', old.id, old.revision + 1, digest, old.root, boundedJson(closure)), ...invalidate(old.id));
  }
  writes.push(sql('INSERT INTO as_requests(id,record_kind,definition,legacy,state,revision,created_at,restored,root,completed_artifacts) VALUES(?,\'native\',?,NULL,\'draft\',1,?,0,NULL,\'[]\')', request.id, boundedJson(def), request.createdAt),
    sql('INSERT INTO as_source_map(source_kind,source_id,source_revision,request_id) VALUES(?,?,?,?)', source.kind, source.id, source.revision, request.id),
    ...def.documents.map(ref => sql('INSERT INTO as_documents(request_id,document_id,reference_json) VALUES(?,?,?)', request.id, ref.id, canonical(ref))),
    ...def.recipients.map(recipient => sql('INSERT INTO as_recipients(request_id,recipient_id,subject_id,participant) VALUES(?,?,?,?)', request.id, recipient.id, recipient.subjectId, canonical(recipient))),
    ...retain(request.id, references(def), await store.commandId(ctx, 'prepare')));
  try { return await store.commit({ ctx, operation: 'prepare', payload: def, before: null, after: request, guard, writes, result: value => value }); }
  catch (error) { if (error instanceof SigningError && error.code === 'conflict') { const result = await store.replay<RequestRecord>(ctx, 'prepare', def); if (result) return result; } throw error; }
}
export async function issue(store: Store, ctx: CommandContext, input: VersionedId): Promise<IssueResult> {
  command(ctx); version(input);
  const recovered = await store.replay<IssueResult>(ctx, 'issue', input); if (recovered) return recovered;
  const request = await store.request(input.id);
  requireThat(!request.restored, 'restored_inert'); requireThat(request.revision === input.revision, 'stale'); requireThat(request.state === 'draft', 'closed');
  requireThat(request.definition.expiresAt === null || request.definition.expiresAt > store.now(), 'expired');
  const expiresAt = new Date(Math.min(Date.parse(store.now()) + limits.credentialSeconds * 1000, request.definition.expiresAt ? Date.parse(request.definition.expiresAt) : Infinity)).toISOString();
  const invitations = store.options.invitations === 'capability' ? request.definition.recipients.map(recipient => ({ recipientId: recipient.id, token: randomToken(), expiresAt })) : [];
  const writes: Sql[] = [];
  for (const invitation of invitations) writes.push(sql('INSERT INTO as_credentials(digest,request_id,recipient_id,expires_at,revoked) VALUES(?,?,?,?,0)', await sha256(invitation.token), request.id, invitation.recipientId, invitation.expiresAt));
  try { return await store.commit({ ctx, operation: 'issue', payload: input, before: request, after: { ...request, state: 'issued' }, guard: and(await store.source(ctx, request, 'issue'), unexpired(request)), writes, result: value => ({ request: value, invitations }), secret: true }); }
  catch (error) { if (error instanceof SigningError && error.code === 'conflict') { const result = await store.replay<IssueResult>(ctx, 'issue', input); if (result) return result; } throw error; }
}
export async function close(store: Store, ctx: CommandContext, input: CloseInput): Promise<RequestRecord> {
  command(ctx); object(input, ['request', 'state', 'reason']); version(input.request); text(input.reason, 4096);
  requireThat(['declined', 'cancelled', 'expired', 'withdrawn'].includes(input.state));
  const recovered = await store.replay<RequestRecord>(ctx, 'close', input); if (recovered) return recovered;
  const request = await store.request(input.request.id);
  requireThat(!request.restored, 'restored_inert'); requireThat(request.revision === input.request.revision, 'stale');
  requireThat(['draft', 'issued', 'in-progress'].includes(request.state), 'closed');
  requireThat(input.state === 'expired' || request.definition.closures.includes(input.state), 'unsupported');
  const expiration = input.state === 'expired' ? sql("julianday(json_extract(definition,'$.expiresAt'))<=julianday('now')") : sql('1');
  const guard = and(await store.source(ctx, request, 'close'), sql(`EXISTS(SELECT 1 FROM as_requests WHERE id=? AND (${expiration.sql}))`, request.id, ...expiration.params ?? []));
  try { return await store.commit({ ctx, operation: 'close', payload: input, before: request, after: { ...request, state: input.state }, guard, writes: invalidate(request.id), result: value => value, detail: { reason: input.reason } }); }
  catch (error) { if (error instanceof SigningError && error.code === 'conflict') { const result = await store.replay<RequestRecord>(ctx, 'close', input); if (result) return result; } throw error; }
}
export async function recordExternal(store: Store, ctx: CommandContext, input: ExternalExecution): Promise<ExecutionRecord> {
  command(ctx); object(input, ['request', 'provider', 'providerRequestId', 'provenance', 'disposition', 'artifacts']); version(input.request);
  text(input.provider); text(input.providerRequestId);
  object(input.provenance, ['source', 'receivedAt', 'attribution']); text(input.provenance.source); timestamp(input.provenance.receivedAt); text(input.provenance.attribution, 4096);
  requireThat(['matched', 'mismatch-accepted', 'mismatch-pending', 'rejected'].includes(input.disposition));
  requireThat(Array.isArray(input.artifacts) && input.artifacts.length > 0 && input.artifacts.length <= limits.documents); input.artifacts.forEach(artifact);
  boundedJson(input);
  const recovered = await store.replay<ExecutionRecord>(ctx, 'external', input); if (recovered) return recovered;
  const request = await store.request(input.request.id); requireThat(!request.restored, 'restored_inert'); requireThat(request.revision === input.request.revision, 'stale');
  await verifyReferences(store, input.artifacts);
  const execution: ExecutionRecord = { ...input, kind: 'external-execution', id: 'ase_' + crypto.randomUUID(), actorId: ctx.actorId, at: store.now() };
  const known = await store.rows<{ reference_json: string }>(sql('SELECT reference_json FROM as_artifacts WHERE request_id=?', request.id));
  const refs = input.artifacts.filter(ref => !known.some(row => row.reference_json === canonical(ref)));
  requireThat(known.length + refs.length <= limits.artifacts, 'capacity');
  try { return await store.commit({ ctx, operation: 'external', payload: input, before: request, after: request,
    guard: await store.source(ctx, request, 'external'), writes: [sql('INSERT INTO as_external_executions(id,request_id,provider,provider_request_id,payload) VALUES(?,?,?,?,?)', execution.id, request.id, input.provider, input.providerRequestId, boundedJson(execution)), ...retain(request.id, refs, await store.commandId(ctx, 'external'))], execution, result: () => execution }); }
  catch (error) { if (error instanceof SigningError && error.code === 'conflict') { const result = await store.replay<ExecutionRecord>(ctx, 'external', input); if (result) return result; } throw error; }
}
