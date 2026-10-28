import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

// Only the network edge is replaced; the packed CLI owns all orchestration.
export async function setupServer(t, cookie) {
 const state = { businesses: [], profile: null, policy: { paused: false }, approved: false, receipts: [], requests: [],
  seeds: ['happytohelp', 'orbit', 'mango', 'uptime', 'oncall'].map(app => ({ app, required: true, state: 'adopted' })) };
 const root = '/api/business/demo-business', tokens = new Map();
 function projection() {
  const seeds = state.seeds.map(seed => {
   const saved = state.receipts.find(row => row.app === seed.app) ?? {};
   const complete = seed.provisioned === true && seed.settings_delivered === true && seed.token_issued === true && saved.seeded === true && saved.no_policy_refused === true && saved.policy_call === true && saved.attributed === true && saved.pause_refused === true && Boolean(saved.policy_id);
   return { ...seed, ...saved, adopted: seed.state === 'adopted', complete, state: complete ? 'already provisioned' : seed.state };
  });
  const required = seeds.filter(seed => seed.required);
  return { synthetic: true, business_id: 'demo-business', policy_id: state.policy.revision?.revision ?? null, complete: required.length > 0 && required.every(seed => seed.complete) && !state.policy.paused, required_total: required.length, required_provisioned: required.filter(seed => seed.provisioned).length, seeds };
 }
 function respond(method, path, body, token) {
  if (path === '/api/business' && method === 'GET') return { businesses: state.businesses };
  if (path === '/api/business' && method === 'POST') {
   assert.equal(state.businesses.length, 0);
   assert.ok(['managed', 'assisted', 'self_host'].includes(body.default_hosting));
   assert.equal(body.executor_preference, body.default_hosting === 'self_host' ? 'local' : 'managed');
   const business = { id: 'demo-business', ...body }; state.businesses.push(business); return { business };
  }
  if (path === root + '/profile' && method === 'PUT') { assert.equal(state.profile, null); state.profile = body; return { profile: body }; }
  if (path === root + '/demo' && method === 'GET') return projection();
  if (path === root + '/demo/plan' && method === 'POST') { assert.deepEqual(body, { confirmed: true }); return { plan_id: 'demo-plan', approved: state.approved }; }
  if (path === root + '/plans/demo-plan/approve' && method === 'POST') { assert.equal(state.approved, false); state.approved = true; return { approved: true }; }
  if (path === root + '/demo/advance' && method === 'POST') {
   for (const seed of state.seeds.filter(row => row.state === 'adopted')) Object.assign(seed, { provisioned: true, installation_id: 'install-' + seed.app, scopes: ['records:write'] });
   return { advanced: true };
  }
  if (path === root + '/settings/deliver' && method === 'POST') {
   assert.deepEqual(body, {});
   return { deliveries: state.seeds.filter(row => row.provisioned).map(seed => { seed.settings_delivered = true; return { installation_id: seed.installation_id, state: 'delivered' }; }) };
  }
  if (path === root + '/agents/seed-token' && method === 'POST') {
   const seed = state.seeds.find(row => row.app === body.seed);
   assert.equal(body.installation_id, seed.installation_id); assert.deepEqual(body.scopes, seed.scopes);
   assert.equal(seed.token_issued, undefined); seed.token_issued = true;
   const access_token = randomBytes(32).toString('hex'); tokens.set(seed.app, access_token);
   return { access_token };
  }
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
   assert.equal(token, tokens.get(app));
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
   const result = respond(request.method, request.url, body, request.headers['x-rer-demo-seed-token']);
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
