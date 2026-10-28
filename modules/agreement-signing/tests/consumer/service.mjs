import { artifactRef, canonical, createSigningService, sha256 } from '../../index.ts';

export function authority(session, sourceId, manage = false) {
  return { sql: `SELECT 1 FROM native_sessions s JOIN native_access a ON a.actor_id=s.actor_id
    WHERE s.id=? AND s.active=1 AND a.source_id=? ${manage ? 'AND a.can_manage=1' : ''}`,
    params: [session.id, sourceId] };
}

export function context(session, sourceId, operationKey, manage = false) {
  return { actorId: session.actor_id, operationKey, authority: authority(session, sourceId, manage),
    agent: session.agent_id ? { id: session.agent_id, sponsorId: session.sponsor_id } : null,
    subjectId: session.subject_id, bindingId: session.id, authentication: session.authentication,
    peer: { ip: null, userAgent: null } };
}

export async function signing(env) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(env.CREDENTIAL_KEY), item => item.charCodeAt(0)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return createSigningService({
    database: env.DB, credentialKey: key, invitations: env.PROFILE === 'text-terms' ? 'native-session' : 'capability',
    sourceGuard(ctx, definition) {
      return { sql: `SELECT 1 FROM native_sources n JOIN native_access a ON a.source_id=n.id
        WHERE n.id=? AND CAST(n.revision AS TEXT)=? AND n.state='approved' AND a.actor_id=?
        AND json_extract(n.definition,'$.approvalDigest')=? AND json_extract(n.definition,'$.selectionDigest') IS ?`,
        params: [definition.source.id, definition.source.revision, ctx.actorId, definition.approvalDigest, definition.selectionDigest] };
    },
    participantGuard(ctx, request, participant, binding) {
      const fields = binding ? canonical(binding.fields) : null;
      return { sql: `SELECT 1 FROM native_sessions s JOIN native_participants p ON p.subject_id=s.subject_id
        WHERE s.id=? AND s.active=1 AND s.actor_id=? AND s.subject_id=? AND s.authentication=?
        AND p.source_id=? AND p.recipient_id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM native_sources n
          WHERE n.id=p.source_id AND json(n.approved_fields)=?))`, params: [ctx.bindingId, ctx.actorId, ctx.subjectId, ctx.authentication,
          request.definition.source.id, participant.id, fields, fields] };
    },
    artifacts: {
      async read(reference) {
        const row = await env.DB.prepare('SELECT bytes FROM native_objects WHERE id=? AND version=?').bind(reference.id, reference.version).first();
        return row ? new Uint8Array(row.bytes) : null;
      },
      async put(reference, bytes) {
        if (await sha256(bytes) !== reference.sha256 || bytes.byteLength !== reference.size) throw new Error('Native custody rejected mismatching bytes');
        const existing = await env.DB.prepare('SELECT bytes FROM native_objects WHERE id=? AND version=?').bind(reference.id, reference.version).first();
        if (existing) {
          if (await sha256(new Uint8Array(existing.bytes)) !== reference.sha256) throw new Error('Immutable native artifact already exists with different bytes');
          return;
        }
        const failure = await env.DB.prepare("SELECT value FROM native_settings WHERE id='artifact-write-failure'").first();
        if (failure.value === 'true') throw new Error('Injected custody write failure');
        await env.DB.prepare('INSERT INTO native_objects (id,version,reference,bytes,source_id) VALUES (?,?,?,?,?)')
          .bind(reference.id, reference.version, JSON.stringify(reference), bytes, reference.id.split('/')[0]).run();
      },
    },
    async finalize(request, actions) {
      const facts = canonical({ source: request.definition.source,
        approvalDigest: request.definition.approvalDigest, selectionDigest: request.definition.selectionDigest,
        actions: actions.map(action => ({ recipientId: action.recipientId, act: action.act, documents: action.documents, consents: action.consents, signableDigest: action.signableDigest })) });
      const mediaType = request.definition.kind === 'terms-acceptance' ? 'text/plain' : 'text/html';
      const content = mediaType === 'text/plain' ? facts : `<!doctype html><meta charset="utf-8"><title>Executed agreement</title><pre>${facts.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`;
      const bytes = new TextEncoder().encode(content);
      const reference = await artifactRef(`${request.definition.source.id}/${request.id}/executed`, '1', mediaType, bytes);
      return [{ reference, bytes }];
    },
    nativeCommit({ operation, request, action }) {
      if (operation !== 'sign' || !action) return [];
      const statements = [{ sql: 'INSERT INTO native_signing_actions (id,request_id,source_id,payload) VALUES (?,?,?,?)',
        params: [action.id, request.id, request.definition.source.id, JSON.stringify(action)] }];
      if (request.state === 'completed') statements.push({ sql: `INSERT INTO native_completed_agreements
        (request_id,source_id,amount_minor,currency,payload) SELECT ?,id,amount_minor,currency,? FROM native_sources WHERE id=?`,
        params: [request.id, JSON.stringify({ request, action }), request.definition.source.id] });
      return statements;
    },
  });
}
