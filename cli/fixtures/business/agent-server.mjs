import { createServer } from 'node:http';

// A fake Business MCP at the network edge: the executors token route and /api/business/mcp (Streamable HTTP JSON-RPC 2025-11-25),
// with the agent tools' result shapes. `state` is the test's handle on what it saw and how it answers next.
export async function agentServer(t, device) {
 const state = { mints: 0, bearers: new Set(), stale: new Set(), calls: [], followed: [], published: 0, stall: false };
 // The phases the next change.follow calls return, the last one repeating; what each phase says to do next.
 let script = [];
 const next = { working: 'wait', preview_ready: 'publish', publishing: 'wait', live: 'done' };
 const tools = [['installations.list', 'List the installed apps'], ['change.request', 'Ask for a change'], ['domain.records', 'DNS records'], ['app.send_sign_in_link', 'Sign-in link']];
 const refusal = structuredContent => ({ isError: true, content: [{ type: 'text', text: structuredContent.message }], structuredContent });
 const answer = (structuredContent) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent });
 function call(name, args) {
  state.calls.push([name, args]);
  if (name === 'installations.list') return answer({ installations: [{ installation_id: 'inst_1', app: 'happytohelp', name: state.appName ?? 'Support', state: 'running', version: '0.4.1', app_url: 'https://help.example.test' }] });
  if (name === 'change.request') { script = ['working', 'working', 'preview_ready']; return answer({ change: { id: 'chg_1', state: 'working' }, next: 'wait' }); }
  if (name === 'change.follow') {
   const phase = state.stall ? 'working' : script.length > 1 ? script.shift() : script[0];
   state.followed.push(phase);
   return answer({ change: { id: args.change_id, state: phase }, next: next[phase] });
  }
  if (name === 'change.publish') { script = ['publishing', 'live']; state.published++; return answer({ change: { id: args.change_id, state: 'publishing' }, next: 'wait' }); }
  if (name === 'domain.records') return refusal({ status: 'not_built', code: 'not_built', message: 'not built yet' });
  if (name === 'app.send_sign_in_link') return refusal({ status: 'action_not_granted', code: 'action_not_granted', action: 'app.send_sign_in_link', message: 'The owner has not granted this action.' });
  return refusal({ status: 'refused', code: 'unknown_tool', message: `No tool ${name}` });
 }
 const server = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (state.httpRefusal && request.url === state.httpRefusal.route) {
   if (state.httpRefusal.raw !== undefined) { response.writeHead(state.httpRefusal.status, { 'content-type': 'application/json' }); return response.end(state.httpRefusal.raw); }
   return json(state.httpRefusal.status, state.httpRefusal.body);
  }
  const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
  if (request.url === '/api/business/executors/token') {
   if (token !== device) return json(401, { error: 'unknown device' });
   const bearer = `bz_task_fixture-${++state.mints}`; state.bearers.add(bearer);
   const expiresIn = state.tokenLifetime ?? 300;
   state.lastExpiry = Date.now() + expiresIn * 1_000;
   return json(200, { access_token: bearer, token_type: 'Bearer', expires_in: expiresIn, expires_at: new Date(state.lastExpiry).toISOString(), audience: `${state.origin}/api/business/mcp`, task_id: null });
  }
  if (request.url !== '/api/business/mcp') return json(404, { error: 'no route' });
  if (!state.bearers.has(token) || state.stale.has(token)) return json(401, { error: 'bearer expired' });
  const reply = result => json(200, { jsonrpc: '2.0', id: body.id, result });
  if (state.rpcRefusal?.method === body.method) return json(200, { jsonrpc: '2.0', id: body.id, error: state.rpcRefusal.error });
  if (body.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'business', version: '1' } });
  if (body.method === 'notifications/initialized') { response.writeHead(202, { 'content-length': 0 }); return response.end(); }
  if (body.method === 'tools/list') return reply({ tools: tools.map(([name, description]) => ({ name, description, inputSchema: { type: 'object' } })) });
  if (body.method === 'tools/call') return reply(state.toolResult ?? call(body.params.name, body.params.arguments));
  return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => server.close());
 state.origin = `http://127.0.0.1:${server.address().port}`;
 return state;
}
