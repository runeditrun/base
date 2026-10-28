import { boundedJson, canonical, limits, sha256, unbase64 } from './encoding.ts';
import { references, unique } from './custody.ts';
import { requireThat } from './errors.ts';
import { artifact, binding as validateBinding, definition, object, text, timestamp, version } from './validation.ts';
import type { ActionRecord, ArtifactRef, AuditEvent, EvidenceBundle, LegacyRecord, RequestRecord, VerificationIssue, VerificationResult } from './types.ts';
export function legacyRecord(value: LegacyRecord): void {
  object(value, ['recordKind', 'id', 'source', 'kind', 'state', 'originalId', 'originalAuditRoot', 'historical', 'artifacts', 'authentication', 'consent', 'createdAt', 'restored']);
  requireThat(value.recordKind === 'legacy'); text(value.id); text(value.originalId);
  object(value.source, ['kind', 'id', 'revision']); text(value.source.kind); text(value.source.id); text(value.source.revision);
  requireThat(['electronic-signature', 'terms-acceptance', 'customer-attestation', 'external-execution'].includes(value.kind));
  requireThat(['draft', 'issued', 'in-progress', 'completed', 'declined', 'cancelled', 'expired', 'withdrawn'].includes(value.state));
  if (value.originalAuditRoot !== null) text(value.originalAuditRoot, 1024);
  if (value.authentication !== null) text(value.authentication);
  requireThat(value.consent === null || Array.isArray(value.consent));
  if (value.consent) for (const item of value.consent) { artifact(item.wording); timestamp(item.acceptedAt); text(item.language); text(item.purpose); }
  requireThat(Array.isArray(value.artifacts)); unique(value.artifacts); timestamp(value.createdAt); requireThat(typeof value.restored === 'boolean');
  boundedJson(value);
}
export function nativeRecord(value: RequestRecord): void {
  object(value, ['recordKind', 'id', 'revision', 'definition', 'state', 'createdAt', 'restored', 'root', 'completedArtifacts']);
  requireThat(value.recordKind === 'native'); version({ id: value.id, revision: value.revision }); definition(value.definition);
  requireThat(['draft', 'issued', 'in-progress', 'completed', 'declined', 'cancelled', 'expired', 'withdrawn'].includes(value.state));
  timestamp(value.createdAt); requireThat(typeof value.restored === 'boolean');
  requireThat(value.root === null || /^[a-f0-9]{64}$/.test(value.root));
  requireThat(Array.isArray(value.completedArtifacts)); unique(value.completedArtifacts);
}
export function bundleReferences(bundle: EvidenceBundle): ArtifactRef[] {
  const request = bundle.request;
  return unique([
    ...(request.recordKind === 'native' ? [...references(request.definition), ...request.completedArtifacts] : [...request.artifacts, ...request.consent?.map(value => value.wording) ?? []]),
    ...bundle.actions.flatMap(action => [...action.documents, ...action.consents.map(value => value.wording), ...action.artifacts,
      ...(action.act.type === 'drawn-signature' ? [action.act.artifact] : [])]),
    ...bundle.executions.flatMap(execution => [...execution.artifacts]),
  ]);
}
async function verifyAction(action: ActionRecord, request: RequestRecord): Promise<boolean> {
  object(action, ['id', 'requestId', 'recipientId', 'actorId', 'subjectId', 'authentication', 'bindingDigest', 'kind', 'at', 'source', 'approvalDigest', 'selectionDigest', 'documents', 'fields', 'act', 'consents', 'peer', 'signableDigest', 'receiptDigest', 'artifacts']);
  const def = request.definition;
  const person = def.recipients.find(recipient => recipient.id === action.recipientId);
  if (!person || person.action === 'view' || person.subjectId !== action.subjectId || person.authentication !== action.authentication || action.requestId !== request.id || action.kind !== def.kind) return false;
  text(action.actorId); text(action.bindingDigest); timestamp(action.at);
  const consents = action.consents.map(({ acceptedAt, ...item }) => { timestamp(acceptedAt); return item; });
  if (canonical(consents) !== canonical(def.consents) || canonical(action.source) !== canonical(def.source) || action.approvalDigest !== def.approvalDigest || action.selectionDigest !== def.selectionDigest) return false;
  const documents = def.documents.filter(document => person.documentIds.includes(document.id));
  if (canonical(documents) !== canonical(action.documents)) return false;
  const binding = { documentIds: person.documentIds, approvalDigest: def.approvalDigest, selectionDigest: def.selectionDigest,
    fields: action.fields, act: action.act, consents };
  validateBinding(binding, def, person.documentIds);
  requireThat(/^[a-f0-9]{64}$/.test(action.bindingDigest));
  object(action.peer, ['ip', 'userAgent']);
  if (action.peer.ip !== null) text(action.peer.ip, 128);
  if (action.peer.userAgent !== null) text(action.peer.userAgent, 1024);
  const payload = { requestId: request.id, source: def.source, kind: def.kind, recipient: person, documents, binding,
    actorId: action.actorId, subjectId: action.subjectId, bindingDigest: action.bindingDigest, authentication: action.authentication };
  return await sha256(boundedJson(payload)) === action.signableDigest && await sha256(canonical({ ...action, receiptDigest: '' })) === action.receiptDigest;
}
async function verifyEvents(bundle: EvidenceBundle, issues: Set<VerificationIssue>): Promise<void> {
  const request = bundle.request;
  if (request.recordKind === 'legacy') {
    if (bundle.actions.length || bundle.events.length || bundle.executions.length) issues.add('shape');
    return;
  }
  const actions: ActionRecord[] = [], executions = [];
  let previous: string | null = null;
  let last: AuditEvent | null = null;
  for (const [index, event] of bundle.events.entries()) {
    object(event, ['sequence', 'previous', 'digest', 'algorithm', 'payload']);
    const { payload } = event;
    object(payload, ['operation', 'actorId', 'agent', 'at', 'commandId', 'request', 'action', 'execution', 'detail']);
    text(payload.actorId); text(payload.commandId); timestamp(payload.at); nativeRecord(payload.request); boundedJson(payload);
    if (event.sequence !== index + 1 || event.previous !== previous || event.algorithm !== 'sha256-canonical-json-v1' || payload.request.root !== previous
      || payload.request.revision !== event.sequence || payload.request.id !== request.id || canonical(payload.request.definition) !== canonical(request.definition)) issues.add('chain');
    if (await sha256(canonical({ sequence: event.sequence, previous: event.previous, algorithm: event.algorithm, payload })) !== event.digest) issues.add('chain');
    const beforeState = last?.payload.request.state;
    const afterState = payload.request.state;
    if (payload.operation === 'prepare') {
      if (index !== 0 || afterState !== 'draft' || payload.action || payload.execution) issues.add('chain');
    } else if (payload.operation === 'issue') {
      if (beforeState !== 'draft' || afterState !== 'issued' || payload.action || payload.execution) issues.add('chain');
    } else if (payload.operation === 'review') {
      if (!['issued', 'in-progress'].includes(beforeState ?? '') || afterState !== beforeState || payload.action || payload.execution) issues.add('chain');
    } else if (payload.operation === 'sign') {
      const action = payload.action;
      if (!action || payload.agent !== null || payload.execution || !['issued', 'in-progress'].includes(beforeState ?? '')) issues.add('chain');
      else {
        if (actions.some(item => item.recipientId === action.recipientId) || !await verifyAction(action, request)) issues.add('receipt');
        const person = request.definition.recipients.find(item => item.id === action.recipientId);
        if (!person || request.definition.recipients.some(item => item.action !== 'view' && item.order < person.order && !actions.some(prior => prior.recipientId === item.id))) issues.add('binding');
        actions.push(action);
        const complete = request.definition.recipients.every(item => item.action === 'view' || actions.some(prior => prior.recipientId === item.id));
        if (afterState !== (complete ? 'completed' : 'in-progress')) issues.add('chain');
        if (complete && request.definition.completion === 'artifacts-required' && action.artifacts.length === 0) issues.add('binding');
      }
    } else if (payload.operation === 'close') {
      if (!['draft', 'issued', 'in-progress'].includes(beforeState ?? '') || !['declined', 'cancelled', 'expired', 'withdrawn'].includes(afterState) || payload.action || payload.execution) issues.add('chain');
    } else if (payload.operation === 'external') {
      if (!payload.execution || payload.action || afterState !== beforeState || payload.execution.kind !== 'external-execution' || payload.execution.request.id !== request.id) issues.add('chain');
      else executions.push(payload.execution);
    } else issues.add('chain');
    previous = event.digest; last = event;
  }
  if (!last || last.digest !== request.root || canonical({ ...last.payload.request, root: last.digest, restored: request.restored }) !== canonical(request)) issues.add('chain');
  const sorted = <T extends { id: string }>(items: readonly T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  if (canonical(sorted(actions)) !== canonical(sorted(bundle.actions)) || canonical(sorted(executions)) !== canonical(sorted(bundle.executions))) issues.add('receipt');
}
/** Checks byte/lineage integrity. An independently retained root anchors provenance; this is not PKI/legal certification. */
export async function verify(bundle: EvidenceBundle, expectedRoot?: string): Promise<VerificationResult> {
  const issues = new Set<VerificationIssue>();
  try {
    object(bundle, ['format', 'request', 'actions', 'events', 'executions', 'artifacts']); requireThat(bundle.format === 'agreement-signing/v1');
    requireThat(Array.isArray(bundle.actions) && Array.isArray(bundle.events) && Array.isArray(bundle.executions) && Array.isArray(bundle.artifacts));
    requireThat(bundle.actions.length <= limits.recipients && bundle.events.length <= limits.events && bundle.executions.length <= limits.events && bundle.artifacts.length <= limits.artifacts, 'capacity');
    if (bundle.request.recordKind === 'native') nativeRecord(bundle.request); else legacyRecord(bundle.request);
    const required = bundleReferences(bundle);
    requireThat(required.reduce((sum, ref) => sum + ref.size, 0) <= limits.bundleBytes, 'capacity');
    const seen = new Set<string>();
    for (const entry of bundle.artifacts) {
      object(entry, ['reference', 'base64']); artifact(entry.reference);
      requireThat(typeof entry.base64 === 'string' && entry.base64.length <= Math.ceil(limits.artifactBytes / 3) * 4, 'capacity');
      const key = canonical(entry.reference);
      if (seen.has(key) || !required.some(ref => canonical(ref) === key)) issues.add('binding'); seen.add(key);
      const bytes = unbase64(entry.base64);
      if (bytes.byteLength !== entry.reference.size) issues.add('artifact-size');
      if (await sha256(bytes) !== entry.reference.sha256) issues.add('artifact-digest');
    }
    if (required.some(ref => !seen.has(canonical(ref)))) issues.add('missing-artifact');
    await verifyEvents(bundle, issues);
    const root = bundle.request.recordKind === 'native' ? bundle.request.root : bundle.request.originalAuditRoot;
    if (expectedRoot !== undefined && root !== expectedRoot) issues.add('root');
    return issues.size ? { valid: false, issues: [...issues] } : { valid: true, root };
  } catch { return { valid: false, issues: [...issues, 'shape'] }; }
}
