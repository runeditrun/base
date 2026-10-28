import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Only the network edge is replaced; the packed CLI owns all orchestration.
export async function setupServer(t, cookie) {
 const state = { businesses: [], profile: null, policy: { paused: false }, approved: false, receipts: [], requests: [],
  seeds: ['happytohelp', 'orbit', 'mango', 'uptime', 'oncall'].map(app => ({ app, required: true, state: 'adopted' })) };
 const root = '/api/business/demo-business';
 function respond(method, path, body) {
  if (path === '/api/business' && method === 'GET') return { businesses: state.businesses };
  if (path === '/api/business' && method === 'POST') {
   assert.equal(state.businesses.length, 0);
   assert.ok(['managed', 'assisted', 'self_host'].includes(body.default_hosting));
   assert.equal(body.executor_preference, body.default_hosting === 'self_host' ? 'local' : 'managed');
   const business = { id: 'demo-business', ...body }; state.businesses.push(business); return { business };
  }
  if (path === root + '/profile' && method === 'PUT') { assert.equal(state.profile, null); state.profile = body; return { profile: body }; }
  if (path === root + '/demo' && method === 'GET') return { seeds: state.seeds, receipts: state.receipts };
  if (path === root + '/demo/plan' && method === 'POST') { assert.deepEqual(body, { confirmed: true }); return { plan_id: 'demo-plan', approved: state.approved }; }
  if (path === root + '/plans/demo-plan/approve' && method === 'POST') { assert.equal(state.approved, false); state.approved = true; return { approved: true }; }
  if (path === root + '/demo/advance' && method === 'POST') return { advanced: true };
  if (path === root + '/apps' && method === 'GET') return { apps: state.seeds.filter(row => row.state === 'adopted').map(row => ({ app: row.app, stage: 'ready' })) };
  if (path === root + '/agents/policy' && method === 'GET') return state.policy;
  if (path === root + '/agents/policy/revisions' && method === 'POST') {
   assert.equal(state.policy.revision, undefined);
   assert.equal(body.document.schema, 'rer-agent-policy/1');
   state.policy.draft = { revision: 'demo-policy', document: body.document, document_sha256: 'demo-digest' };
   return { revision: state.policy.draft };
  }
  if (path === root + '/agents/policy/revisions/demo-policy/confirm' && method === 'POST') {
   assert.deepEqual(body, { digest: state.policy.draft.document_sha256 });
   state.policy.revision = state.policy.draft; delete state.policy.draft; return { confirmed: true };
  }
  if (path === root + '/pause' && method === 'POST') { state.policy.paused = body.paused; return { paused: body.paused }; }
  const match = path.match(/^\/api\/business\/demo-business\/demo\/apps\/([^/]+)\/door$/);
  if (match && method === 'POST') {
   const app = decodeURIComponent(match[1]);
   assert.ok(state.seeds.some(row => row.app === app));
   if (body.phase === 'unset') { assert.equal(state.policy.revision, undefined); return { app, no_policy_refused: true }; }
   if (body.phase === 'seed') {
    assert.ok(state.policy.revision); assert.equal(state.policy.paused, false);
    assert.ok(!state.receipts.some(row => row.app === app), 'no second credential or fixture write');
    const receipt = { app, state: 'provisioned', seeded: true, token_id: 'token-' + app, consent_id: 'consent-' + app,
     policy_id: state.policy.revision.revision, no_policy_refused: true, policy_call: true, attributed: true, fixture_calls: 1 };
    state.receipts.push(receipt); return receipt;
   }
   assert.equal(body.phase, 'paused'); assert.equal(state.policy.paused, true);
   const receipt = state.receipts.find(row => row.app === app); receipt.pause_refused = true;
   return { app, pause_refused: true };
  }
  throw Error(`Unexpected setup edge: ${method} ${path}`);
 }
 const server = createServer(async (request, response) => {
  try {
   assert.equal(request.headers.cookie, cookie);
   assert.equal(request.headers.origin, state.origin);
   let text = ''; for await (const chunk of request) text += chunk;
   const body = text ? JSON.parse(text) : undefined;
   state.requests.push({ method: request.method, path: request.url, body });
   if (state.refusal) {
    response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify(state.refusal)); return;
   }
   const result = respond(request.method, request.url, body);
   response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) {
   state.error = error;
   response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'test_edge_failed' }));
  }
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
 state.origin = 'http://127.0.0.1:' + server.address().port;
 return state;
}
