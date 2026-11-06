import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Only the network edge is replaced: the platform's owner routes for creating a Business and saving its profile.
export async function setupServer(t, cookie) {
 const state = { businesses: [], profile: null, requests: [] };
 const root = '/api/business/demo-business';
 function respond(method, path, body) {
  if (path === '/api/business' && method === 'GET') return { businesses: state.businesses };
  if (path === '/api/business' && method === 'POST') {
   assert.equal(state.businesses.length, 0);
   assert.ok(['managed', 'assisted', 'self_host'].includes(body.default_hosting));
   assert.equal(body.executor_preference, body.default_hosting === 'self_host' ? 'local' : 'managed');
   const business = { id: 'demo-business', ...body }; state.businesses.push(business); return { business };
  }
  if (path === root + '/profile' && method === 'GET') return { profile: state.profile ?? {}, apps: [] };
  if (path === root + '/profile' && method === 'PUT') { state.profile = { ...state.profile, ...body }; return { saved: true, profile: state.profile }; }
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
   // The platform answers a created Business with 201.
   response.writeHead(request.method === 'POST' && request.url === '/api/business' ? 201 : 200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
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
