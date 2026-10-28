import { requirePost } from '../../../../modules/operator-auth/http.mjs';
import { readInput } from '../../../../modules/operator-auth/input.mjs';

export const phaseFixtureSchema = `
CREATE TABLE fixture_native_clients (
 id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 token_hash TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 specialist TEXT NOT NULL, scopes TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE fixture_native_operations (
 key TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES fixture_native_clients(id),
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), record_id TEXT NOT NULL,
 value TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

const text = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const receiptSchema = object({ key: text, clientId: text, recordId: text, value: text });
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const identity = row => ({ sponsor: { id: row.operator_id }, clientId: row.id,
 agent: { id: row.agent_id, name: row.name, specialist: row.specialist }, scopes: JSON.parse(row.scopes) });
const uri = id => `fixture://record/${id}`;

// This is the fixture application's native credential and mutation adapter.
// Both HTTP and MCP resolve the same persisted credential and operation custody.
export function createPhaseClients({ db, records, ToolRefusal }) {
 async function localCredentials(request) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token?.startsWith('fixture_native_')) return null;
  const row = await db.prepare('SELECT * FROM fixture_native_clients WHERE token_hash=? AND active=1').bind(await digest(token)).first();
  return row ? identity(row) : null;
 }
 async function currentScopes(principal) {
  if (!principal.clientId?.startsWith('fixture-client:')) return principal.scopes;
  const row = await db.prepare('SELECT * FROM fixture_native_clients WHERE id=? AND active=1').bind(principal.clientId).first();
  if (!row || row.operator_id !== principal.person.id || row.agent_id !== principal.agent.id) return [];
  return JSON.parse(row.scopes);
 }
 async function receipt(key, person, clientId) {
  await records.authorize(person);
  if (!clientId) throw new ToolRefusal('native_client_required');
  const saved = await db.prepare('SELECT key,client_id AS clientId,record_id AS recordId,value FROM fixture_native_operations WHERE key=? AND operator_id=? AND client_id=?')
   .bind(key, person.id, clientId).first();
  if (!saved) throw new ToolRefusal('operation_not_found');
  return saved;
 }
 async function retainedRecord(id, ctx) {
  await records.authorize(ctx.person);
  if (!ctx.clientId) throw new ToolRefusal('native_client_required');
  const saved = await db.prepare('SELECT record_id AS id FROM fixture_native_operations WHERE record_id=? AND operator_id=? AND client_id=?')
   .bind(id, ctx.person.id, ctx.clientId).first();
  if (!saved) throw new ToolRefusal('operation_not_found');
  return saved;
 }
 const tools = [
  { name: 'fixture.clients.receipt', title: 'Read native operation receipt', description: 'Read an operation retained by your authenticated native client.',
   scope: 'records:read', readOnly: true, inputSchema: object({ key: text }), outputSchema: receiptSchema, classes: ['standard'], clauses: ['BASE-AGENT-002'],
   classify: () => [{ class: 'standard', facts: { measure: 1 } }],
   async run(args, ctx) { return { result: await receipt(args.key, ctx.person, ctx.clientId) }; } },
  { name: 'fixture.records.erase', title: 'Erase a native record', description: 'Delete an existing native record belonging to the sponsoring person.',
   scope: 'records:write', readOnly: false, inputSchema: object({ id: text }), outputSchema: object({ id: text }), classes: ['destructive'], clauses: ['BASE-AGENT-006'],
   classify: async (args, ctx) => { await retainedRecord(args.id, ctx); return [{ class: 'destructive', facts: { measure: 1 } }]; },
   summary: async (args, ctx) => ({ target: { id: (await retainedRecord(args.id, ctx)).id } }),
   target: async (args, ctx) => ({ kind: 'record', id: (await retainedRecord(args.id, ctx)).id }),
   async run(args, ctx) {
    const record = await records.read(args.id, ctx.person);
    const deleted = await db.prepare('DELETE FROM fixture_records WHERE id=? AND operator_id=? AND NOT EXISTS(SELECT 1 FROM fixture_receipts WHERE record_id=?)').bind(record.id, ctx.person.id, record.id).run();
    if (deleted.meta.changes !== 1) throw new ToolRefusal('record_has_external_receipts');
    ctx.emit('record.erased', uri(record.id));
    return { result: { id: record.id } };
   } },
 ];
 async function handle(request, { auth, config, people, door }) {
  const path = new URL(request.url).pathname;
  if (path === '/app/clients') {
   requirePost(request, config);
   const session = await auth.getSession(request);
   if (!session || session.operator.role !== 'owner') return Response.json({ error: 'owner_required' }, { status: 403 });
   await records.authorize(session.operator);
   const input = await readInput(request);
   if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) return Response.json({ error: 'invalid_client' }, { status: 400 });
   const token = 'fixture_native_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
   const row = { id: 'fixture-client:' + crypto.randomUUID(), operator_id: session.operator.id, agent_id: crypto.randomUUID(), name: input.name,
    specialist: 'operations', scopes: JSON.stringify(['records:read', 'records:write', 'events:read']) };
   await db.prepare('INSERT INTO fixture_native_clients(id,operator_id,token_hash,agent_id,name,specialist,scopes) VALUES(?,?,?,?,?,?,?)')
    .bind(row.id, row.operator_id, await digest(token), row.agent_id, row.name, row.specialist, row.scopes).run();
   const { clientId, agent } = identity(row);
   return Response.json({ token, clientId, agent }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  }
  if (path !== '/api/v1/records' && !path.startsWith('/api/v1/operations/')) return null;
  const credentials = await localCredentials(request);
  const person = credentials && await people.person(credentials.sponsor.id);
  if (!person?.active) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  await records.authorize(person);
  if (path === '/api/v1/records') {
   if (request.method !== 'POST') return new Response(null, { status: 405 });
   if (!credentials.scopes.includes('records:write')) return Response.json({ error: 'insufficient_scope' }, { status: 403 });
   const record = await records.create((await readInput(request)).value, person);
   const key = crypto.randomUUID();
   await db.prepare('INSERT INTO fixture_native_operations(key,client_id,operator_id,record_id,value,created_at) VALUES(?,?,?,?,?,?)')
    .bind(key, credentials.clientId, person.id, record.id, record.value, Date.now()).run();
   await door.emit({ type: 'record.created', uri: uri(record.id), person, data: { clientId: credentials.clientId, operationKey: key } });
   return Response.json({ record, operation: await receipt(key, person, credentials.clientId) }, { status: 201 });
  }
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  if (!credentials.scopes.includes('records:read')) return Response.json({ error: 'insufficient_scope' }, { status: 403 });
  return Response.json(await receipt(decodeURIComponent(path.slice('/api/v1/operations/'.length)), person, credentials.clientId));
 }
 return { tools, localCredentials, currentScopes, handle };
}
