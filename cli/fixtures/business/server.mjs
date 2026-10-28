import { createServer } from 'node:http';
import { actionBody, closed, eventId, identifier, integer, object, requireValue, usage } from './contract.mjs';
import { taskStore } from './task-state.mjs';

export const classificationSchema = {
 type: 'object', additionalProperties: false, required: ['vendor_id', 'usage', 'confidence'],
 properties: { vendor_id: { type: 'string', enum: ['sentry', 'uptimerobot', 'none'] },
  usage: { type: 'string', enum: usage }, confidence: { type: 'number', minimum: 0, maximum: 1 } },
};
const version = '2025-11-25';
const later = seconds => new Date(Date.now() + seconds * 1000).toISOString();

/** Network edge from platform b64ab7f5: executors/{pairing,tokens,tasks,mcp}.ts. */
export async function server(t) {
 const state = { approved: false, requests: [], tasks: [], released: null, checkpoint: {}, uploads: [], phase: 'ready', fence: 0, grants: new Map(), claims: new Map() };
 state.business = { id: 'biz', name: 'synthetic-base-1', legal_name: null, brand_color: '#264F45', logo_url: null };
 const device = 'bz_device_fixture-credential';
 const tokens = new Map(), tasks = taskStore(state);
 let redeemed = false, issued = false, tokenSequence = 0, origin, pairingExpires = 0;
 function requireDevice(request) {
  requireValue(issued && !state.revoked && request.headers.authorization === `Bearer ${device}`, 401);
 }
 function bearer(request, audience, taskId) {
  const token = tokens.get(request.headers.authorization);
  requireValue(issued && !state.revoked && token?.audience === audience && token.until > Date.now(), 401);
  if (taskId !== undefined) requireValue(token.taskId === taskId, 403);
  return token;
 }
 function mint(request, body) {
  requireDevice(request); closed(body, ['audience', 'task_id', 'expires_in']);
  requireValue(['mcp', 'tasks'].includes(body.audience));
  const maximum = body.audience === 'mcp' ? 300 : 900, seconds = body.expires_in ?? maximum;
  integer(seconds, maximum); requireValue(seconds > 0);
  if (body.task_id !== undefined) {
   requireValue(typeof body.task_id === 'string');
   const task = tasks.find(body.task_id);
   requireValue(task.summary.runner === 'executor', 403);
   requireValue(task.phase === 'leased' || body.audience === 'mcp' && task.phase === 'ready', 403);
  } else requireValue(body.audience === 'mcp');
  const access = `bz_task_fixture-${++tokenSequence}`;
  tokens.set(`Bearer ${access}`, { audience: body.audience, taskId: body.task_id ?? null, until: Date.now() + seconds * 1000 });
  return { access_token: access, token_type: 'Bearer', expires_in: seconds, expires_at: later(seconds),
   audience: `${origin}/api/business/${body.audience === 'mcp' ? 'mcp' : 'tasks'}`, task_id: body.task_id ?? null };
 }
 function pair(body) {
  if (body.pairing_token !== undefined) {
   closed(body, ['pairing_token']);
   requireValue(typeof body.pairing_token === 'string' && body.pairing_token.length <= 200);
   requireValue(redeemed && !issued && body.pairing_token === 'fixture-pairing-poll' && Date.now() < pairingExpires, 401, 'Pairing expired or used');
   if (!state.approved) return [{ status: 'authorization_pending', interval: state.pollSeconds ?? 5 }, 202];
   issued = true;
   return [{ status: 'paired', device_credential: device, executor_id: 'executor1', business_id: 'biz', idle_expires_at: later(30 * 24 * 3600) }, 200];
  }
  closed(body, ['code', 'device_name', 'working_folder', 'os', 'agent_kind', 'capabilities']);
  requireValue(typeof body.code === 'string' && body.code.length <= 100);
  // The platform's own limits: a short single-line name, and an absolute folder.
  requireValue(body.device_name === undefined || typeof body.device_name === 'string' && body.device_name.trim() && body.device_name.length <= 200 && !/[\r\n\x00-\x1f]/.test(body.device_name));
  requireValue(body.working_folder === undefined || typeof body.working_folder === 'string' && body.working_folder.length <= 1000 && !/[\x00-\x1f\x7f]/.test(body.working_folder) && (body.working_folder.startsWith('/') || body.working_folder.startsWith('~/')));
  requireValue(body.code === 'ABCD-1234', 401, 'Pairing expired or used');
  requireValue(['macos', 'linux', 'wsl', 'windows', 'other'].includes(body.os) && ['codex', 'claude', 'other'].includes(body.agent_kind));
  requireValue(Array.isArray(body.capabilities) && body.capabilities.length <= 100 && body.capabilities.every(value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value)));
  // Each explicit pairing starts a fresh browser-created fixture pairing.
  // Like the platform, the code's own expiry applies until approval.
  redeemed = true; issued = false; state.approved = false; state.revoked = false; state.active = false; state.agentKind = body.agent_kind;
  const seconds = state.pairingSeconds ?? 600; pairingExpires = Date.now() + seconds * 1000;
  return [{ status: 'pending_approval', pairing_token: 'fixture-pairing-poll', confirmation_number: '246810', expires_at: later(seconds), interval: state.pollSeconds ?? 5 }, 202];
 }
 function tool(token, name, args) {
  object(args);
  if (name === 'next_question' || name === 'business_status') {
   closed(args, []);
   if (name === 'business_status') return { execution: 'enabled', tasks: [], inventory: [] };
   return { tasks: state.tasks.filter(task => token.taskId === null || token.taskId === task.task_id).map(task => tasks.summary(tasks.find(task.task_id))),
    instruction: 'Mint a bearer bound to a selected task before answering. Human-only steps remain in the browser.' };
  }
  if (name === 'explain_task') {
   closed(args, ['task_id']); identifier(args.task_id);
   requireValue(token.taskId === null || token.taskId === args.task_id, 403);
   return tasks.summary(tasks.find(args.task_id));
  }
  if (name === 'read_plan') {
   closed(args, ['plan_id']); if (args.plan_id !== undefined) identifier(args.plan_id);
   return { state: 'not_found' };
  }
  requireValue(name === 'answer');
  identifier(args.task_id); eventId(args.client_event_id); integer(args.fence);
  requireValue(['claim', 'heartbeat', 'events', 'complete', 'release'].includes(args.action));
  requireValue(token.taskId !== null && token.taskId === args.task_id, 403);
  const { task_id: id, action, ...body } = args;
  actionBody(action, body, true);
  const result = tasks.action(id, action, body, true);
  return { ...tasks.summary(tasks.find(id)), ...(result.grant ? { grant_id: result.grant.id } : {}), replayed: result.replayed,
   ...(action === 'heartbeat' ? { controls: result.controls, cursor: result.cursor, cancel_requested: result.cancel_requested, heartbeat_interval_seconds: 60 } : {}) };
 }
 function mcp(request, body, send) {
  const token = bearer(request, 'mcp');
  closed(body, ['jsonrpc', 'id', 'method', 'params']);
  requireValue(body.jsonrpc === '2.0' && typeof body.method === 'string');
  requireValue(request.headers['mcp-protocol-version'] === version || body.method === 'initialize' && request.headers['mcp-protocol-version'] === undefined);
  requireValue(request.headers.accept?.includes('application/json') && request.headers.accept?.includes('text/event-stream'));
  const rpc = result => send({ jsonrpc: '2.0', id: body.id, result });
  if (body.method === 'initialize') {
   requireValue(body.id !== undefined);
   closed(body.params, ['protocolVersion', 'capabilities', 'clientInfo']);
   requireValue(body.params.protocolVersion === version); object(body.params.capabilities);
   closed(body.params.clientInfo, ['name', 'version']);
   requireValue(typeof body.params.clientInfo.name === 'string' && typeof body.params.clientInfo.version === 'string');
   return rpc({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'rer-business', version: '1.0.0' } });
  }
  if (body.method === 'notifications/initialized') {
   requireValue(body.id === undefined); closed(body.params, ['_meta']);
   return send(undefined, 202);
  }
  requireValue(body.id !== undefined && body.method === 'tools/call');
  closed(body.params, ['name', 'arguments', '_meta']);
  try {
   const summary = tool(token, body.params.name, body.params.arguments ?? {});
   return rpc({ content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary, isError: false });
  } catch (error) {
   if (!error.status || [400, 401, 403].includes(error.status) || error.status >= 500) throw error;
   return rpc({ content: [{ type: 'text', text: 'Action unavailable' }], structuredContent: { status: 'action_unavailable' }, isError: true });
  }
 }
 const http = createServer(async (request, response) => {
  const send = (value, status = 200) => { response.statusCode = status; response.end(value === undefined ? undefined : JSON.stringify(value)); };
  response.setHeader('Content-Type', 'application/json');
  try {
   let raw = ''; for await (const chunk of request) { raw += chunk; requireValue(Buffer.byteLength(raw) <= 2 * 1024 * 1024, 413); }
   let body; try { body = JSON.parse(raw || '{}'); } catch { requireValue(false); }
   object(body);
   const route = request.url;
   state.requests.push({ route, body, authorization: request.headers.authorization, method: request.method });
   if (route === '/api/business/executors/self') {
    requireDevice(request);
    // Like the platform, the first device-authenticated request activates the
    // computer, including on a platform without these routes (it answers 403).
    if (request.method === 'GET') await state.onSelf?.();
    state.active = true;
    if (state.selfMissing) return send({}, 403);
    // The platform's computer projection: the device as it reported itself, and the owner's choices.
    if (request.method === 'GET') return send({ business: state.business, device: { agent_kind: { value: state.agentKind, source: 'device_reported' } }, optIns: state.optIns ?? { installPermissions: null, awakeConsent: null, installService: null } });
    requireValue(request.method === 'DELETE', 405);
    if (state.revokeRefused) return send({}, 503);
    state.revoked = true; return send({ revoked: true });
   }
   requireValue(request.method === 'POST', 405);
   if (route === '/api/business/biz/pairings/pair1/approve') {
    closed(body, ['confirmation_number', 'confirmed']);
    requireValue(redeemed && !issued && Date.now() < pairingExpires && body.confirmation_number === '246810' && body.confirmed === true, 403);
    // Approval gives the computer ten more minutes to collect its credential.
    state.approved = true; pairingExpires = Date.now() + 600_000; return send({ approved: true });
   }
   if (route === '/api/business/executors/pair') {
    if (body.pairing_token && state.pairingRefused) return send({ error: 'Pairing expired or used', requestId: 'fixture-request' }, 401);
    return send(...pair(body));
   }
   if (route === '/api/business/executors/token') return send(mint(request, body));
   if (route === '/api/business/mcp') return mcp(request, body, send);
   if (route === '/api/business/executors/claim') { requireDevice(request); return send(tasks.claim(body)); }
   const granting = /^\/api\/business\/tasks\/([^/]+)\/import-grants$/.exec(route);
   if (granting) {
    if (request.headers.authorization === `Bearer ${device}`) { requireDevice(request); requireValue(false, 403); }
    const id = decodeURIComponent(granting[1]); bearer(request, 'tasks', id);
    return send(tasks.importGrant(id, body));
   }
   const match = /^\/api\/business\/tasks\/([^/]+)\/(heartbeat|events|complete|release|uploads)$/.exec(route);
   if (match) {
    if (request.headers.authorization === `Bearer ${device}`) { requireDevice(request); requireValue(false, 403); }
    const id = decodeURIComponent(match[1]); bearer(request, 'tasks', id);
    return send(tasks.action(id, match[2], body));
   }
   return send({}, 404);
  } catch (error) { send({ error: error.reason ?? 'Fixture request refused' }, error.status ?? 500); }
 });
 await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
 origin = `http://127.0.0.1:${http.address().port}`;
 const close = () => !http.listening ? Promise.resolve() : new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
 t.after(close);
 return { state, origin, device, close };
}
