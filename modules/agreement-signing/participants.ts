import { boundedJson, canonical, limits, randomToken, sha256 } from './encoding.ts';
import { requireThat, SigningError } from './errors.ts';
import { bytes, stage, verifyReferences } from './custody.ts';
import { active, and, sql, Store, unexpired } from './store.ts';
import { binding, digest, object, participantContext, text, version } from './validation.ts';
import type { ActionRecord, OneUseReview, Participant, ParticipantContext, RequestRecord, ReviewBinding, ReviewInput, ReviewRedemption, SigningResult, Sql } from './types.ts';
interface ReviewRow {
  digest: string; request_id: string; recipient_id: string; actor_id: string; subject_id: string;
  binding_id: string; authentication: string; binding_json: string; signable_digest: string; expires_at: string; used_at: string | null;
}
function participant(request: RequestRecord, ctx: ParticipantContext, recipientId: string): Participant {
  const person = request.definition.recipients.find(value => value.id === recipientId);
  requireThat(person && person.subjectId === ctx.subjectId && person.authentication === ctx.authentication, 'wrong_participant');
  requireThat(person.action !== 'view', 'unsupported'); return person;
}
async function participantGuard(store: Store, ctx: ParticipantContext, request: RequestRecord, recipientId: string): Promise<Sql> {
  const person = participant(request, ctx, recipientId);
  return and(ctx.authority, await store.options.participantGuard(ctx, request, person, null));
}
async function guards(store: Store, request: RequestRecord, ctx: ParticipantContext, person: Participant, credential: string | null, operation: 'review' | 'sign', reviewBinding: ReviewBinding): Promise<Sql> {
  let credentialSql: Sql;
  if (store.options.invitations === 'capability') {
    requireThat(typeof credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credential), 'credential');
    credentialSql = sql("EXISTS(SELECT 1 FROM as_credentials WHERE digest=? AND request_id=? AND recipient_id=? AND revoked=0 AND julianday(expires_at)>julianday('now'))", await sha256(credential), request.id, person.id);
  } else { requireThat(credential === null, 'credential'); credentialSql = sql('1'); }
  const authority = and(await store.source(ctx, request, operation), await store.options.participantGuard(ctx, request, person, reviewBinding));
  await store.allowed(authority);
  const ordering = sql(`NOT EXISTS(SELECT 1 FROM as_recipients r WHERE r.request_id=? AND json_extract(r.participant,'$.action')<>'view'
    AND json_extract(r.participant,'$.order')<? AND NOT EXISTS(SELECT 1 FROM as_actions a WHERE a.request_id=r.request_id AND a.recipient_id=r.recipient_id))`, request.id, person.order);
  const inOrder = await store.first<{ ok: number }>(sql(`SELECT (${ordering.sql}) AS ok`, ...ordering.params ?? []));
  requireThat(inOrder?.ok === 1, 'ordering');
  const authorizedCredential = await store.first<{ ok: number }>(sql(`SELECT (${credentialSql.sql}) AS ok`, ...credentialSql.params ?? []));
  requireThat(authorizedCredential?.ok === 1, 'credential');
  return and(authority, ordering, credentialSql, unexpired(request), sql("EXISTS(SELECT 1 FROM as_requests WHERE id=? AND state IN ('issued','in-progress') AND restored=0)", request.id));
}
async function signedPayload(request: RequestRecord, ctx: ParticipantContext, person: Participant, reviewBinding: ReviewBinding) {
  return { requestId: request.id, source: request.definition.source, kind: request.definition.kind, recipient: person,
    documents: request.definition.documents.filter(document => person.documentIds.includes(document.id)), binding: reviewBinding,
    actorId: ctx.actorId, subjectId: ctx.subjectId, bindingDigest: await sha256(ctx.bindingId), authentication: ctx.authentication };
}
function commandPayload(ctx: ParticipantContext, input: ReviewInput | ReviewRedemption) {
  return { input, subjectId: ctx.subjectId, bindingId: ctx.bindingId, authentication: ctx.authentication };
}
export async function review(store: Store, ctx: ParticipantContext, input: ReviewInput): Promise<OneUseReview> {
  participantContext(ctx); object(input, ['request', 'recipientId', 'credential', 'binding']); version(input.request); text(input.recipientId);
  const payload = commandPayload(ctx, input);
  const replayGuard = (request: RequestRecord) => participantGuard(store, ctx, request, input.recipientId);
  const recovered = await store.replay<OneUseReview>(ctx, 'review', payload, replayGuard); if (recovered) return recovered;
  const request = await store.request(input.request.id);
  active(request, store.now()); requireThat(request.revision === input.request.revision, 'stale');
  const person = participant(request, ctx, input.recipientId);
  binding(input.binding, request.definition, person.documentIds);
  const guard = await guards(store, request, ctx, person, input.credential, 'review', input.binding);
  const approved = await signedPayload(request, ctx, person, input.binding);
  await verifyReferences(store, [...approved.documents, ...input.binding.consents.map(value => value.wording), ...(input.binding.act.type === 'drawn-signature' ? [input.binding.act.artifact] : [])]);
  const token = randomToken();
  const signableDigest = await sha256(boundedJson(approved));
  const expiresAt = new Date(Math.min(Date.parse(store.now()) + limits.reviewSeconds * 1000, request.definition.expiresAt ? Date.parse(request.definition.expiresAt) : Infinity)).toISOString();
  const result: OneUseReview = { requestId: request.id, recipientId: person.id, token, signableDigest, expiresAt, documents: approved.documents };
  const writes = [sql('INSERT INTO as_reviews(digest,request_id,recipient_id,actor_id,subject_id,binding_id,authentication,binding_json,signable_digest,expires_at,used_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',
    await sha256(token), request.id, person.id, ctx.actorId, ctx.subjectId, ctx.bindingId, ctx.authentication, boundedJson(input.binding), signableDigest, expiresAt)];
  try { return await store.commit({ ctx, operation: 'review', payload, before: request, after: request, guard, writes, result: () => result,
    detail: { recipientId: person.id, signableDigest }, secret: true }); }
  catch (error) { if (error instanceof SigningError && error.code === 'conflict') { const result = await store.replay<OneUseReview>(ctx, 'review', payload, replayGuard); if (result) return result; } throw error; }
}
export async function sign(store: Store, ctx: ParticipantContext, input: ReviewRedemption): Promise<SigningResult> {
  participantContext(ctx); object(input, ['requestId', 'recipientId', 'credential', 'token', 'signableDigest']);
  text(input.requestId); text(input.recipientId); text(input.token, 128); digest(input.signableDigest);
  const payload = commandPayload(ctx, input);
  const replayGuard = (request: RequestRecord) => participantGuard(store, ctx, request, input.recipientId);
  // Other equal-order participants can commit while this act is rendering. Rebase only
  // on a newer kernel revision, never on different source/binding/participant bytes.
  for (let attempt = 0; attempt < limits.events; attempt++) {
    const recovered = await store.replay<SigningResult>(ctx, 'sign', payload, replayGuard); if (recovered) return recovered;
    const request = await store.request(input.requestId);
    active(request, store.now());
    const person = participant(request, ctx, input.recipientId);
    const reviewDigest = await sha256(input.token);
    const reviewed = await store.first<ReviewRow>(sql('SELECT * FROM as_reviews WHERE digest=? AND request_id=? AND recipient_id=?', reviewDigest, request.id, person.id));
    requireThat(reviewed && reviewed.actor_id === ctx.actorId && reviewed.subject_id === ctx.subjectId && reviewed.binding_id === ctx.bindingId && reviewed.authentication === ctx.authentication, 'wrong_participant');
    requireThat(reviewed.used_at === null, 'review_used'); requireThat(reviewed.expires_at > store.now(), 'expired');
    requireThat(reviewed.signable_digest === input.signableDigest, 'stale');
    const reviewBinding = JSON.parse(reviewed.binding_json) as ReviewBinding;
    binding(reviewBinding, request.definition, person.documentIds);
    const guard = await guards(store, request, ctx, person, input.credential, 'sign', reviewBinding);
    requireThat(await sha256(boundedJson(await signedPayload(request, ctx, person, reviewBinding))) === input.signableDigest, 'stale');
    const documents = request.definition.documents.filter(document => person.documentIds.includes(document.id));
    await verifyReferences(store, [...documents, ...reviewBinding.consents.map(value => value.wording), ...(reviewBinding.act.type === 'drawn-signature' ? [reviewBinding.act.artifact] : [])]);
    let action: ActionRecord = {
      id: 'asa_' + await store.commandId(ctx, 'sign'), requestId: request.id, recipientId: person.id, actorId: ctx.actorId, subjectId: ctx.subjectId,
      authentication: ctx.authentication, bindingDigest: await sha256(ctx.bindingId), kind: request.definition.kind, at: store.now(), source: request.definition.source,
      approvalDigest: request.definition.approvalDigest, selectionDigest: request.definition.selectionDigest, documents,
      fields: reviewBinding.fields, act: reviewBinding.act, consents: reviewBinding.consents.map(value => ({ ...value, acceptedAt: store.now() })),
      peer: ctx.peer, signableDigest: input.signableDigest, receiptDigest: '', artifacts: [],
    };
    const prior = await store.actions(request.id);
    requireThat(!prior.some(value => value.recipientId === person.id), 'review_used');
    const completed = request.definition.recipients.filter(value => value.action !== 'view').every(value => value.id === person.id || prior.some(item => item.recipientId === value.id));
    const fence = and(guard, sql('EXISTS(SELECT 1 FROM as_requests WHERE id=? AND revision=? AND root IS ?)', request.id, request.revision, request.root),
      sql("EXISTS(SELECT 1 FROM as_reviews WHERE digest=? AND used_at IS NULL AND julianday(expires_at)>julianday('now') AND signable_digest=?)", reviewDigest, input.signableDigest));
    try {
      const commandId = await store.commandId(ctx, 'sign');
      const payloadDigest = await sha256(boundedJson(payload));
      await store.batch([...store.assert(fence), sql('INSERT OR IGNORE INTO as_action_intents(command_id,request_id,payload_digest,action) VALUES(?,?,?,?)', commandId, request.id, payloadDigest, boundedJson(action)),
        ...store.assert(sql('(SELECT COUNT(*) FROM as_action_intents WHERE request_id=?)<=?', request.id, limits.events))]);
      const intent = await store.first<{ payload_digest: string; action: string }>(sql('SELECT payload_digest,action FROM as_action_intents WHERE command_id=?', commandId));
      requireThat(intent && intent.payload_digest === payloadDigest, 'replay_mismatch');
      action = JSON.parse(intent.action) as ActionRecord;
      let artifactWrites: Sql[] = [];
      if (action.act.type === 'drawn-signature') {
        const reference = action.act.artifact;
        artifactWrites.push(...await stage(store, request.id, commandId, fence, [{ reference, bytes: await bytes(store, reference) }]));
      }
      if (completed && store.options.finalize) {
        const uploads = await store.options.finalize(request, [...prior, action]);
        requireThat(uploads.length > 0 || request.definition.completion !== 'artifacts-required', 'artifact_missing');
        if (uploads.length) artifactWrites.push(...await stage(store, request.id, commandId, fence, uploads));
        action.artifacts = uploads.map(upload => upload.reference);
      }
      action.receiptDigest = await sha256(canonical({ ...action, receiptDigest: '' }));
      const after: RequestRecord = { ...request, state: completed ? 'completed' : 'in-progress', completedArtifacts: completed ? action.artifacts : request.completedArtifacts };
      const writes = [
        ...artifactWrites,
        sql('UPDATE as_reviews SET used_at=? WHERE request_id=? AND recipient_id=? AND used_at IS NULL', action.at, request.id, person.id),
        sql('UPDATE as_credentials SET revoked=1 WHERE request_id=? AND recipient_id=?', request.id, person.id),
        sql('INSERT INTO as_actions(id,request_id,recipient_id,payload) VALUES(?,?,?,?)', action.id, request.id, person.id, boundedJson(action)),
        sql('DELETE FROM as_action_intents WHERE command_id=?', commandId),
      ];
      return await store.commit({ ctx, operation: 'sign', payload, before: request, after, guard: fence, writes, action, result: value => ({ request: value, action }) });
    } catch (error) {
      const conflict = error instanceof SigningError ? error.code === 'conflict' : error instanceof Error && /constraint|CHECK|UNIQUE/i.test(error.message);
      if (!conflict) throw error;
      const recovered = await store.replay<SigningResult>(ctx, 'sign', payload, replayGuard); if (recovered) return recovered;
      const current = await store.request(request.id);
      if (current.revision > request.revision && !current.restored) continue;
      throw new SigningError('conflict');
    }
  }
  throw new SigningError('conflict');
}
