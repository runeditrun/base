import { createServer } from 'node:http';

// The management service's device edge, in memory: pairing, heartbeat
// controls, claims, and the event/result relay. Every request is recorded.
export async function managementServer(t, { repository, projectId }) {
 const state = { requests: [], token: 'fixture-device-key-0001', code: 'ABCD-2345', job: null, claimed: false, controls: [], failResults: 0, onRequest: () => {} };
 const reply = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
 const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {}, path = request.url;
  const record = { path, body, authorization: request.headers.authorization ?? null };
  state.requests.push(record);
  if (path === '/api/local/pair') {
   if (body.code !== state.code) return reply(response, 401, { error: 'Pairing expired or used' });
   state.code = null;
   return reply(response, 200, { data: { token: state.token, device: { id: 'device-1', provider: body.provider, project_id: body.project_id }, repository } });
  }
  if (record.authorization !== `Bearer ${state.token}`) return reply(response, 401, { error: 'Device revoked or unknown' });
  state.onRequest(record);
  if (path === '/api/local/heartbeat') {
   const controls = state.controls.filter(control => control.sequence > body.cursor);
   return reply(response, 200, { data: { active_jobs: [], controls, cursor: controls.at(-1)?.sequence ?? body.cursor } });
  }
  if (path === '/api/local/claim') {
   const job = state.job && !state.claimed ? state.job : null;
   if (job) state.claimed = true;
   return reply(response, 200, { data: job });
  }
  if (/^\/api\/local\/jobs\/[^/]+\/result$/.test(path) && state.failResults > 0) { state.failResults--; return reply(response, 503, { error: 'Unavailable' }); }
  if (/^\/api\/local\/jobs\/[^/]+\/(events|result)$/.test(path)) return reply(response, 200, { data: { accepted: true } });
  reply(response, 404, { error: 'Not found' });
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
 state.origin = `http://127.0.0.1:${server.address().port}`;
 state.queue = (id, { baseCommit, instructions, provider = 'codex' }) => {
  const runId = `run-${id}`;
  state.job = { id, run_id: runId, request_id: `request-${id}`, project_id: projectId, installation_id: projectId, device_id: 'device-1', repository, base_commit: baseCommit, instructions,
   execution_grant: { id: `grant-${id}`, installationId: projectId, deviceId: 'device-1', userId: 'owner-1', jobId: id, runId, requestId: `request-${id}`, projectId, provider, executor: 'local', managementReservationId: null, issuedAt: new Date().toISOString() } };
  state.claimed = false;
 };
 state.posted = suffix => state.requests.filter(request => request.path.endsWith(suffix));
 return state;
}
