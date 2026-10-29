import { application } from './application.mjs';
import { createAuthHandler, createSignInHandler, AuthError } from '../../../../modules/operator-auth/index.mjs';
import { requirePost, escapeHtml, securityHeaders } from '../../../../modules/operator-auth/http.mjs';
import { readInput } from '../../../../modules/operator-auth/input.mjs';
import { createOwnerClaimHandler } from '../../../../modules/owner-claim/index.mjs';
import { ToolRefusal } from '../../../../modules/agent-door/index.ts';
import receiver from './receiver.mjs';
import { queue } from './queued.mjs';
import { issueProof } from './authority.mjs';
export { NativeJobs } from './queued.mjs';
const uri = id => `fixture://record/${id}`;
const redirect = () => new Response(null, { status: 303, headers: { ...securityHeaders(), Location: '/app' } });

export default {
  queue,
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true, deployment: { sourceSha: env.RER_DEPLOY_SOURCE, fingerprint: env.RER_DEPLOY_FINGERPRINT, versionId: env.RER_VERSION.id } });
    if (path === '/' && ['GET', 'HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Records</title></head><body><main><h1>Records</h1><p>Save internal records, request a provider review, and retain signed delivery receipts.</p><p><a href="/app">Open your records workspace</a></p></main></body></html>', { headers: { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' } });
    const app = await application(env);
    if (app instanceof Response) return app;
    const { origin, nativeMode, config, clientIp, trust, records, door, auth, settings, people, phaseClients } = app;
    const handled = await door.handle(request) ?? await settings.handle(request);
    if (handled) return handled;
    if (path === '/deliveries' && request.method === 'POST') {
      const input = await request.clone().json().catch(() => null);
      const { secret } = await env.DB.prepare('SELECT secret FROM fixture_installation WHERE id=1').first();
      const response = await receiver.fetch(new Request('https://receiver.example.invalid/deliveries', request), { secrets: { DELIVERY_SECRET: secret } });
      if (response.status !== 202) return response;
      const record = input && await env.DB.prepare('SELECT id,value,operator_id FROM fixture_records WHERE id=?').bind(input.recordId).first();
      if (!record || record.value !== input.value) return new Response('Unknown native record', { status: 404 });
      const result = await response.clone().json();
      await records.receipt(record, { id: record.operator_id }, 'inbound', response.status, result, input.deliveryId);
      return response;
    }
    if (path === '/auth/owner-claim' && env.OWNER_MODE === 'signed') return createOwnerClaimHandler({ db: env.DB, authConfig: config, clientIp, ...trust, expectedEmail: config.OWNER_EMAIL })(request);
    if (path === '/auth/bootstrap' && env.OWNER_MODE === 'signed') return new Response('Not found', { status: 404 });
    try {
      if (path === '/auth/reviewer-confirm') {
        requirePost(request, config);
        const value = await auth.confirmLink(request, await readInput(request));
        return Response.json({ confirmed: true }, { headers: { ...securityHeaders(), 'Set-Cookie': value.cookie } });
      }
      const phaseResponse = await phaseClients?.handle(request, { auth, config, people, door });
      if (phaseResponse) return phaseResponse;
      if (path === '/app/review' && env.OWNER_MODE === 'native-reviewer') {
        requirePost(request, config);
        const session = await auth.getSession(request);
        if (!session) return Response.json({ error: 'unauthenticated' }, { status: 401 });
        const input = await readInput(request);
        if (input.action === 'prepare' && session.operator.role === 'owner') {
          const id = crypto.randomUUID();
          await env.DB.prepare('INSERT INTO fixture_reviews(id,preparer_id) VALUES(?,?)').bind(id, session.operator.id).run();
          return Response.json({ id });
        }
        const row = await env.DB.prepare('SELECT preparer_id,reviewer_id FROM fixture_reviews WHERE id=?').bind(input.id).first();
        if (!row || !['owner', 'admin'].includes(session.operator.role) || row.preparer_id === session.operator.id) return Response.json({ error: 'independent_reviewer_required' }, { status: 403 });
        const marked = await env.DB.prepare('UPDATE fixture_reviews SET reviewer_id=? WHERE id=? AND reviewer_id IS NULL AND preparer_id<>?').bind(session.operator.id, input.id, session.operator.id).run();
        return Response.json({ reviewed: marked.meta.changes === 1 });
      }
      if (path === '/app/repository-consent') {
        requirePost(request, config);
        const session = await auth.getSession(request);
        if (!session) return new Response('Native session required', { status: 401 });
        const { id } = await request.json();
        await records.read(id, session.operator);
        await env.DB.prepare('INSERT OR IGNORE INTO fixture_consents(id) VALUES(?)').bind(id).run();
        return Response.json({ consented: true });
      }
      if (path === '/app/native-proof') {
        requirePost(request, config);
        const session = await auth.getSession(request);
        if (!session) return new Response('Native session required', { status: 401 });
        await records.authorize(session.operator);
        return Response.json({ reference: await issueProof(env.DB, session.operator, await request.json()) });
      }
      if (path === '/app/membership/link' && nativeMode) {
        requirePost(request, config);
        const session = await auth.getSession(request);
        if (!session || !['owner', 'admin', 'member'].includes(session.operator.role)) return new Response('Owner session required', { status: 403 });
        await env.DB.prepare('INSERT INTO fixture_members(operator_id,email,joined_at) VALUES(?,?,?) ON CONFLICT(operator_id) DO NOTHING').bind(session.operator.id, session.operator.email, Date.now()).run();
        return request.headers.get('content-type') === 'application/json' ? Response.json({ linked: true }) : redirect();
      }
      if (path === '/app/records') {
        requirePost(request, config);
        const session = await auth.getSession(request);
        if (!session) return new Response('Sign in required', { status: 401 });
        const record = await records.create((await readInput(request)).value, session.operator);
        await door.emit({ type: 'record.created', uri: uri(record.id), person: { id: session.operator.id, name: session.operator.displayName, email: session.operator.email, role: session.operator.role, active: true } });
        return redirect();
      }
      if (path === '/app' && ['GET', 'HEAD'].includes(request.method)) {
        const session = await auth.getSession(request), person = session?.operator;
        const linked = person && (!nativeMode || await env.DB.prepare('SELECT operator_id FROM fixture_members WHERE operator_id=?').bind(person.id).first());
        const state = linked ? await records.list(person) : null;
        const content = !person ? '<p><a href="/signin">Sign in</a> to manage records.</p>' : !linked
          ? '<form method="post" action="/app/membership/link"><button>Join this records workspace</button></form>'
          : `<p>Signed in as ${escapeHtml(person.email)}.</p><form method="post" action="/app/records"><label>Record <input name="value" required maxlength="2000"></label><button>Save record</button></form><ul>${state.records.map(record => `<li>${escapeHtml(record.value)}</li>`).join('')}</ul><p>${state.counts.receipts} retained external receipts.</p>`;
        return new Response(request.method === 'HEAD' ? null : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Records</title></head><body><main><h1>Records</h1>${content}<p><a href="/agents">Agent access and activity</a></p></main></body></html>`, { headers: { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return await createSignInHandler(auth, { defaultReturnTo: '/app', setup: async () => env.OWNER_MODE !== 'signed' && !await env.DB.prepare('SELECT 1 FROM oa_bootstrap LIMIT 1').first() ? {} : null })(request)
        ?? await createAuthHandler(auth)(request) ?? new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof AuthError) return Response.json({ error: error.code }, { status: error.status });
      if (error instanceof ToolRefusal) return Response.json({ error: error.code }, { status: 403 });
      throw error;
    }
  },
};
