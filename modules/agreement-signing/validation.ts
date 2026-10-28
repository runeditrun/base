import { boundedJson, canonical, limits } from './encoding.ts';
import { requireThat } from './errors.ts';
import type { ArtifactRef, CommandContext, ConsentRequirement, ParticipantContext, ReviewBinding, SigningDefinition, VersionedId } from './types.ts';
export function object(value: unknown, keys: readonly string[]): void {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).every(key => keys.includes(key)));
}
export function text(value: unknown, max = 256): asserts value is string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'));
}
export function digest(value: unknown): asserts value is string { requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); }
export function timestamp(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
export function artifact(value: ArtifactRef): void {
  object(value, ['id', 'version', 'mediaType', 'sha256', 'size']);
  text(value.id); text(value.version); text(value.mediaType, 128); digest(value.sha256);
  requireThat(Number.isSafeInteger(value.size) && value.size >= 0);
  requireThat(value.size <= limits.artifactBytes, 'capacity');
}
export function consent(value: ConsentRequirement): void {
  object(value, ['purpose', 'wording', 'language']);
  requireThat(['electronic-records', 'signature-intent', 'accept-terms', 'attestation'].includes(value.purpose));
  artifact(value.wording); text(value.language, 64);
}
export function version(value: VersionedId): void {
  object(value, ['id', 'revision']); text(value.id); requireThat(Number.isSafeInteger(value.revision) && value.revision >= 1);
}
export function command(ctx: CommandContext): void {
  text(ctx.actorId); text(ctx.operationKey); text(ctx.authority.sql, 16_384);
  requireThat(ctx.agent === null || typeof ctx.agent === 'object');
  if (ctx.agent) { text(ctx.agent.id); text(ctx.agent.sponsorId); }
}
export function participantContext(ctx: ParticipantContext): void {
  command(ctx); requireThat(ctx.agent === null, 'unauthorized');
  text(ctx.subjectId); text(ctx.bindingId); text(ctx.authentication);
  requireThat(ctx.peer !== null && typeof ctx.peer === 'object');
  if (ctx.peer.ip !== null) text(ctx.peer.ip, 128);
  if (ctx.peer.userAgent !== null) text(ctx.peer.userAgent, 1024);
}
export function definition(value: SigningDefinition): void {
  object(value, ['source', 'kind', 'documents', 'recipients', 'approvalDigest', 'selectionDigest', 'expiresAt', 'consents', 'completion', 'closures', 'replaces']);
  object(value.source, ['kind', 'id', 'revision']); text(value.source.kind); text(value.source.id); text(value.source.revision);
  requireThat(['electronic-signature', 'terms-acceptance', 'customer-attestation'].includes(value.kind));
  digest(value.approvalDigest); if (value.selectionDigest !== null) digest(value.selectionDigest);
  if (value.expiresAt !== null) timestamp(value.expiresAt);
  requireThat(Array.isArray(value.documents) && value.documents.length > 0);
  requireThat(value.documents.length <= limits.documents, 'capacity'); value.documents.forEach(artifact);
  requireThat(new Set(value.documents.map(ref => ref.id)).size === value.documents.length);
  requireThat(Array.isArray(value.recipients) && value.recipients.length > 0);
  requireThat(value.recipients.length <= limits.recipients, 'capacity');
  requireThat(new Set(value.recipients.map(recipient => recipient.id)).size === value.recipients.length);
  const action = { 'electronic-signature': 'sign', 'terms-acceptance': 'accept', 'customer-attestation': 'attest' }[value.kind];
  for (const recipient of value.recipients) {
    object(recipient, ['id', 'subjectId', 'action', 'order', 'documentIds', 'authentication']);
    text(recipient.id); text(recipient.subjectId); text(recipient.authentication);
    requireThat(recipient.action === action || recipient.action === 'view');
    requireThat(Number.isSafeInteger(recipient.order) && recipient.order >= 0 && recipient.order <= 1024);
    requireThat(Array.isArray(recipient.documentIds) && recipient.documentIds.length > 0 && recipient.documentIds.length <= limits.documents);
    requireThat(new Set(recipient.documentIds).size === recipient.documentIds.length);
    requireThat(recipient.documentIds.every((id: string) => value.documents.some(doc => doc.id === id)));
  }
  requireThat(value.recipients.some(recipient => recipient.action !== 'view'));
  requireThat(Array.isArray(value.consents)); requireThat(value.consents.length <= limits.consents, 'capacity'); value.consents.forEach(consent);
  requireThat(new Set(value.consents.map(item => item.purpose)).size === value.consents.length);
  const purpose = { 'electronic-signature': 'signature-intent', 'terms-acceptance': 'accept-terms', 'customer-attestation': 'attestation' }[value.kind];
  requireThat(value.consents.some(item => item.purpose === purpose));
  requireThat(['receipt-only', 'artifacts-required'].includes(value.completion));
  requireThat(Array.isArray(value.closures) && value.closures.every(state => ['declined', 'cancelled', 'withdrawn'].includes(state)));
  requireThat(new Set(value.closures).size === value.closures.length);
  if (value.replaces !== null) text(value.replaces);
  boundedJson(value);
}
export function binding(value: ReviewBinding, def: SigningDefinition, documentIds: readonly string[]): void {
  object(value, ['documentIds', 'approvalDigest', 'selectionDigest', 'fields', 'act', 'consents']);
  requireThat(canonical(value.documentIds) === canonical(documentIds), 'stale');
  requireThat(value.approvalDigest === def.approvalDigest && value.selectionDigest === def.selectionDigest, 'stale');
  requireThat(canonical(value.consents) === canonical(def.consents), 'stale');
  requireThat(value.fields !== null && typeof value.fields === 'object' && !Array.isArray(value.fields));
  if (def.kind === 'electronic-signature') {
    requireThat(value.act.type === 'typed-signature' || value.act.type === 'drawn-signature');
    if (value.act.type === 'drawn-signature') { object(value.act, ['type', 'name', 'artifact']); artifact(value.act.artifact); }
    else object(value.act, ['type', 'name']);
    text(value.act.name, 512);
  } else {
    requireThat(value.act.type === (def.kind === 'terms-acceptance' ? 'accept' : 'attest'));
    object(value.act, ['type', 'statement']); text(value.act.statement, 4096);
  }
  boundedJson(value);
}
