import { createAgentDoor, defineTool, operatorAuthPeople, ToolRefusal } from '../../../../modules/agent-door/index.ts';
import { createOperatorAuth, createAuthHandler, createSignInHandler, AuthError } from '../../../../modules/operator-auth/index.mjs';
import { requirePost, escapeHtml, securityHeaders } from '../../../../modules/operator-auth/http.mjs';
import { readInput } from '../../../../modules/operator-auth/input.mjs';
import { createOwnerClaimHandler } from '../../../../modules/owner-claim/index.mjs';
import { createBusinessSettings } from '../../../../modules/business-settings/index.ts';
import { deliveryRequest, verifyDeliveryReceipt, OPENAI_AUTHORIZATION } from './receiver.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1 }, integer = { type: 'integer' };
const recordSchema = object({ id: text, value: text, version: integer });
const receiptSchema = object({ id: text, recordId: text, kind: text, status: integer, body: { type: 'object' } });
const standard = () => [{ class: 'standard', facts: { measure: 1 } }];
const external = () => [{ class: 'external', facts: { measure: 1, counterparty: 'known' } }];
const uri = id => `fixture://record/${id}`;
const redirect = () => new Response(null, { status: 303, headers: { ...securityHeaders(), Location: '/app' } });

function nativeRecords(db, nativeMode) {
  async function authorize(person) {
    const operator = await db.prepare("SELECT id FROM oa_operators WHERE id=? AND status='active'").bind(person.id).first();
    if (!operator || nativeMode && !await db.prepare('SELECT operator_id FROM fixture_members WHERE operator_id=?').bind(person.id).first()) throw new ToolRefusal('membership_required');
  }
  async function read(id, person) {
    await authorize(person);
    const record = await db.prepare('SELECT id,value,version FROM fixture_records WHERE id=? AND operator_id=?').bind(id, person.id).first();
    if (!record) throw new ToolRefusal('record_not_found');
    return record;
  }
  async function create(value, person) {
    await authorize(person);
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new ToolRefusal('invalid_record');
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO fixture_records(id,value,version,operator_id) VALUES(?,?,1,?)').bind(id, value, person.id).run();
    return read(id, person);
  }
  async function list(person) {
    await authorize(person);
    const [records, saved] = await Promise.all([
      db.prepare('SELECT id,value,version FROM fixture_records WHERE operator_id=? ORDER BY id').bind(person.id).all(),
      db.prepare('SELECT id,record_id AS recordId,kind,status,body FROM fixture_receipts WHERE operator_id=? ORDER BY id').bind(person.id).all(),
    ]);
    const receipts = saved.results.map(receipt => ({ ...receipt, body: JSON.parse(receipt.body) }));
    return { records: records.results, receipts, counts: { records: records.results.length, receipts: receipts.length } };
  }
  async function receipt(record, person, kind, status, body, id = crypto.randomUUID()) {
    await db.prepare('INSERT INTO fixture_receipts(id,record_id,kind,status,body,operator_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id, record.id, kind, status, JSON.stringify(body), person.id, Date.now()).run();
    return { id, recordId: record.id, kind, status, body };
  }
  return { authorize, read, create, list, receipt };
}

async function openAiReview(record, stream) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: OPENAI_AUTHORIZATION, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1-mini', input: record.value, stream }),
  });
  if (response.status !== 200 || response.headers.get('x-fixture-recursive-network') !== 'denied') throw new ToolRefusal('provider_failed');
  let document, delta = '';
  if (stream) {
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new ToolRefusal('provider_stream_invalid');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === 'response.output_text.delta') delta += event.delta;
          if (event.type === 'response.completed') document = event.response;
        }
        if (chunk.done) break;
      }
    } finally { reader.releaseLock(); }
  } else {
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new ToolRefusal('provider_json_invalid');
    document = await response.json();
  }
  const output = document?.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('');
  if (document?.object !== 'response' || document.status !== 'completed' || typeof document.id !== 'string'
    || output !== `Reviewed: ${record.value}` || stream && delta !== output) throw new ToolRefusal('provider_response_invalid');
  return { providerId: document.id, output, stream, recursiveDenied: true };
}

function recordTools(db, records) {
  const sendInput = object({ id: text, stream: { type: 'boolean' } });
  const target = async (args, ctx, recipient) => ({ target: { id: (await records.read(args.id, ctx.person)).id }, recipients: [recipient] });
  return [
    defineTool({ name: 'fixture.records.list', title: 'List records and receipts', description: 'Read your native records and retained external receipts.', scope: 'records:read', readOnly: true,
      inputSchema: object({}), outputSchema: object({ records: { type: 'array', items: recordSchema }, receipts: { type: 'array', items: receiptSchema }, counts: object({ records: integer, receipts: integer }) }),
      classes: ['standard'], clauses: ['BASE-AGENT-002'], classify: standard,
      async run(_args, ctx) { return { result: await records.list(ctx.person) }; } }),
    defineTool({ name: 'fixture.records.create', title: 'Create record', description: 'Save an internal record. Undo is available until a record has external receipts.', scope: 'records:write', readOnly: false,
      inputSchema: object({ value: { ...text, maxLength: 2000 } }), outputSchema: recordSchema, classes: ['standard'], clauses: ['BASE-AGENT-002'], classify: standard,
      summary: args => ({ target: { name: args.value } }),
      async run(args, ctx) { const record = await records.create(args.value, ctx.person); ctx.emit('record.created', uri(record.id)); return { result: record, undo: { id: record.id } }; },
      async undo(saved, ctx) {
        await records.read(saved.id, ctx.person);
        const deleted = await db.prepare('DELETE FROM fixture_records WHERE id=? AND operator_id=? AND NOT EXISTS(SELECT 1 FROM fixture_receipts WHERE record_id=?)').bind(saved.id, ctx.person.id, saved.id).run();
        if (deleted.meta.changes !== 1) throw new ToolRefusal('record_has_external_receipts');
        ctx.emit('record.undone', uri(saved.id));
      } }),
    defineTool({ name: 'fixture.records.send', title: 'Review record with provider', description: 'Send a record to the Responses API and retain its completed JSON or streamed result.', scope: 'records:write', readOnly: false,
      inputSchema: sendInput, outputSchema: receiptSchema, classes: ['external'], clauses: ['BASE-AGENT-006'], classify: external,
      summary: (args, ctx) => target(args, ctx, 'https://api.openai.com'),
      async run(args, ctx) {
        const record = await records.read(args.id, ctx.person), review = await openAiReview(record, args.stream);
        const receipt = await records.receipt(record, ctx.person, args.stream ? 'openai-stream' : 'openai-json', 200, review);
        ctx.emit('record.sent', uri(record.id), { receiptId: receipt.id }); return { result: receipt };
      } }),
    defineTool({ name: 'fixture.records.deliver', title: 'Deliver signed record', description: 'Deliver a record over HTTPS with HMAC authentication and verify the receiver signed receipt.', scope: 'records:write', readOnly: false,
      inputSchema: object({ id: text }), outputSchema: receiptSchema, classes: ['external'], clauses: ['BASE-AGENT-006'], classify: external,
      summary: (args, ctx) => target(args, ctx, 'https://receiver.example.invalid'),
      async run(args, ctx) {
        const record = await records.read(args.id, ctx.person), deliveryId = crypto.randomUUID();
        const response = await fetch(await deliveryRequest(record, deliveryId));
        if (response.status !== 202) throw new ToolRefusal('delivery_failed');
        const document = await response.json();
        if (!await verifyDeliveryReceipt(document, { deliveryId, recordId: record.id, value: record.value })) throw new ToolRefusal('delivery_receipt_invalid');
        const receipt = await records.receipt(record, ctx.person, 'delivery', response.status, { ...document, signatureVerified: true }, deliveryId);
        ctx.emit('record.delivered', uri(record.id), { receiptId: receipt.id }); return { result: receipt };
      } }),
    defineTool({ name: 'fixture.records.denied', title: 'Check denied destination', description: 'Attempt an undeclared external destination and retain the network refusal.', scope: 'records:write', readOnly: false,
      inputSchema: object({ id: text }), outputSchema: receiptSchema, classes: ['external'], clauses: ['BASE-AGENT-006'],
      classify: () => [{ class: 'external', facts: { measure: 1, counterparty: 'new' } }],
      summary: (args, ctx) => target(args, ctx, 'https://escape.example.invalid'),
      async run(args, ctx) {
        const record = await records.read(args.id, ctx.person);
        const response = await fetch('https://escape.example.invalid/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
        const status = response.status; await response.body?.cancel();
        if (status !== 502) throw new ToolRefusal('undeclared_destination_reached');
        const receipt = await records.receipt(record, ctx.person, 'denied', status, { denied: true, destination: 'https://escape.example.invalid' });
        ctx.emit('record.delivery-denied', uri(record.id), { receiptId: receipt.id }); return { result: receipt };
      } }),
  ];
}

function memberPeople(people, db, nativeMode) {
  const allowed = async person => person && (!nativeMode || await db.prepare('SELECT operator_id FROM fixture_members WHERE operator_id=?').bind(person.id).first()) ? person : null;
  return { ...people, person: async id => allowed(await people.person(id)), sponsor: async claims => allowed(await people.sponsor(claims)), session: async request => allowed(await people.session(request)) };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true, deployment: { sourceSha: env.RER_DEPLOY_SOURCE, fingerprint: env.RER_DEPLOY_FINGERPRINT, versionId: env.RER_VERSION.id } });
    if (path === '/' && ['GET', 'HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Records</title></head><body><main><h1>Records</h1><p>Save internal records, request a provider review, and retain signed delivery receipts.</p><p><a href="/app">Open your records workspace</a></p></main></body></html>', { headers: { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' } });
    const origin = env.RER_OWNER_CLAIM_APP_ORIGIN, nativeMode = env.OWNER_MODE === 'native';
    if (!['signed', 'native', 'setup-token'].includes(env.OWNER_MODE)) return new Response('Invalid owner configuration', { status: 503 });
    const config = { origin, OWNER_EMAIL: nativeMode ? env.SETUP_OPERATOR_EMAIL : env.OWNER_EMAIL, SESSION_SECRET: env.SESSION_SECRET, SETUP_TOKEN: env.SETUP_TOKEN,
      branding: { productName: 'Records' } };
    const clientIp = incoming => incoming.headers.get('CF-Connecting-IP') ?? '';
    const teamAuth = createOperatorAuth({ db: env.DB, config, clientIp });
    const settings = createBusinessSettings({ db: env.DB, trust: env.RER_BUSINESS_TRUST,
      business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } }, team: teamAuth.businessTeam });
    const auth = createOperatorAuth({ db: env.DB, config, clientIp, businessSettings: settings });
    const trust = { issuer: env.OWNER_MODE === 'signed' ? env.RER_MANAGEMENT_ORIGIN : env.RER_OWNER_CLAIM_ISSUER,
      installationId: env.OWNER_MODE === 'signed' ? env.RER_INSTALLATION_ID : env.RER_OWNER_CLAIM_INSTALLATION_ID,
      appOrigin: origin, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) };
    if (!trust.issuer || !trust.installationId) return new Response('Native owner bindings required', { status: 503 });
    const records = nativeRecords(env.DB, nativeMode);
    const door = createAgentDoor({ seed: 'fixture', name: 'Records', specialist: 'operations', origin, db: env.DB, trust, resources: [],
      limits: { requestsPerMinute: 10000 }, tools: recordTools(env.DB, records),
      people: memberPeople(operatorAuthPeople({ db: env.DB, session: incoming => auth.getSession(incoming) }), env.DB, nativeMode) });
    const handled = await door.handle(request) ?? await settings.handle(request);
    if (handled) return handled;
    if (path === '/auth/owner-claim' && env.OWNER_MODE === 'signed') return createOwnerClaimHandler({ db: env.DB, authConfig: config, clientIp, ...trust, expectedEmail: config.OWNER_EMAIL })(request);
    if (path === '/auth/bootstrap' && env.OWNER_MODE === 'signed') return new Response('Not found', { status: 404 });
    try {
      if (path === '/app/membership/link' && nativeMode) {
        requirePost(request, config);
        const session = await auth.getSession(request);
        if (!session || session.operator.role !== 'owner') return new Response('Owner session required', { status: 403 });
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
