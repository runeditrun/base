import { authority, context, signing } from './service.mjs';
import { reviseSource } from './source.mjs';

const json = (body, status = 200) => Response.json(body, { status });
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };

async function sessionFor(request, env) {
  const id = request.headers.get('Cookie')?.match(/(?:^|;\s*)native_session=([^;]+)/)?.[1];
  if (!id) fail('unauthorized', 401);
  const session = await env.DB.prepare('SELECT * FROM native_sessions WHERE id=? AND active=1').bind(id).first();
  if (!session) fail('unauthorized', 401);
  return session;
}

async function allowed(env, session, sourceId, manage = false) {
  const guard = authority(session, sourceId, manage);
  if (!await env.DB.prepare(guard.sql).bind(...guard.params).first()) fail('unauthorized', 403);
}

async function sourceForRequest(env, id) {
  const row = await env.DB.prepare('SELECT source_id FROM as_source_map WHERE request_id=?').bind(id).first();
  if (!row) fail('not_found', 404);
  return row.source_id;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const session = await sessionFor(request, env);
  const input = request.method === 'POST' ? await request.json() : null;
  const key = request.headers.get('Idempotency-Key') ?? '';
  let match;
  if ((match = url.pathname.match(/^\/offers\/([^/]+)(?:\/(agreements|revise))?$/))) {
    const sourceId = decodeURIComponent(match[1]);
    const action = match[2];
    await allowed(env, session, sourceId, request.method === 'POST');
    const source = await env.DB.prepare('SELECT * FROM native_sources WHERE id=?').bind(sourceId).first();
    if (!source) fail('not_found', 404);
    if (request.method === 'GET' && !action) {
      const actions = await env.DB.prepare('SELECT payload FROM native_signing_actions WHERE source_id=? ORDER BY rowid').bind(sourceId).all();
      const completions = await env.DB.prepare('SELECT request_id,source_id,amount_minor,currency FROM native_completed_agreements WHERE source_id=? ORDER BY rowid').bind(sourceId).all();
      const legacy = await env.DB.prepare('SELECT l.* FROM native_legacy_agreements l JOIN native_access a ON a.source_id=l.source_id WHERE a.actor_id=? ORDER BY l.id').bind(session.actor_id).all();
      return json({ source: { id: source.id, revision: source.revision, amountMinor: source.amount_minor, currency: source.currency },
        actions: actions.results.map(row => JSON.parse(row.payload)), completions: completions.results, legacy: legacy.results });
    }
    if (request.method === 'POST' && action === 'agreements') {
      const definition = { ...JSON.parse(source.definition), replaces: input.replaces ?? null };
      return json(await (await signing(env)).prepare(context(session, sourceId, key, true), definition));
    }
    if (request.method === 'POST' && action === 'revise') {
      return json(await reviseSource(env, source));
    }
  }
  if ((match = url.pathname.match(/^\/agreements\/([^/]+)\/(issue|review|sign|close|external|evidence)$/))) {
    const id = decodeURIComponent(match[1]);
    const operation = match[2];
    const sourceId = await sourceForRequest(env, id);
    const service = await signing(env);
    const ctx = context(session, sourceId, key, ['issue', 'close', 'external'].includes(operation));
    if (operation === 'evidence' && request.method === 'GET') return json(await service.evidence(ctx, id));
    if (request.method !== 'POST') fail('method', 405);
    if (operation === 'issue') return json(await service.issue(ctx, { id, revision: input.revision }));
    if (operation === 'review') return json(await service.review(ctx, { ...input, request: { ...input.request, id } }));
    if (operation === 'sign') return json(await service.sign(ctx, { ...input, requestId: id }));
    if (operation === 'close') return json(await service.close(ctx, { ...input, request: { ...input.request, id } }));
    if (operation === 'external') return json(await service.recordExternal(ctx, { ...input, request: { ...input.request, id } }));
  }
  if ((match = url.pathname.match(/^\/files\/([^/]+)\/([^/]+)$/)) && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM native_objects WHERE id=? AND version=?').bind(decodeURIComponent(match[1]), decodeURIComponent(match[2])).first();
    if (!row) fail('not_found', 404);
    await allowed(env, session, row.source_id);
    return new Response(new Uint8Array(row.bytes), { headers: { 'Content-Type': JSON.parse(row.reference).mediaType } });
  }
  if (url.pathname === '/evidence/verify' && request.method === 'POST') {
    const sourceId = input.bundle.request.recordKind === 'legacy' ? input.bundle.request.source.id : input.bundle.request.definition.source.id;
    await allowed(env, session, sourceId);
    return json(await (await signing(env)).verify(input.bundle));
  }
  if (url.pathname === '/evidence/restore' && request.method === 'POST') {
    const sourceId = input.bundle.request.recordKind === 'legacy' ? input.bundle.request.source.id : input.bundle.request.definition.source.id;
    return json(await (await signing(env)).restore(context(session, sourceId, key, true), input.bundle));
  }
  if (url.pathname === '/sessions/rotate' && request.method === 'POST') {
    const replacement = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('UPDATE native_sessions SET active=0 WHERE id=?').bind(session.id),
      env.DB.prepare('INSERT INTO native_sessions SELECT ?,actor_id,subject_id,authentication,agent_id,sponsor_id,1 FROM native_sessions WHERE id=?').bind(replacement, session.id),
    ]);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': `native_session=${replacement}; Path=/; HttpOnly; Secure; SameSite=Strict` } });
  }
  if (url.pathname === '/access/revoke' && request.method === 'POST') {
    await allowed(env, session, 'offer-main', true);
    await env.DB.prepare('UPDATE native_sessions SET active=0 WHERE actor_id=?').bind(input.actorId).run();
    return json({ revoked: true });
  }
  fail('not_found', 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (error) { return json({ code: error.code ?? 'internal', message: error.message }, error.status ?? 500); }
  },
};
