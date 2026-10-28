import { defineTool, ToolRefusal } from '../../../../modules/agent-door/index.ts';
import { AuthError } from '../../../../modules/operator-auth/index.mjs';

const text = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const role = { type: 'string', enum: ['admin', 'member'] };
const result = object({ id: text, role: text, status: text, version: { type: 'integer' } });
const clauses = ['BASE-AGENT-006'];

// The same production delegated-administration service as the maintained Base
// reference: native authorization, transactions and audit remain authoritative.
export function accessTools(db, auth, records) {
 const read = id => db.prepare('SELECT id,email,display_name AS name,role,status,version FROM oa_operators WHERE id=?').bind(id).first();
 const commands = ctx => auth.delegatedAdministration({ personId: ctx.person.id, auditLabel: ctx.actor.label, agentId: ctx.agent.id });
 const act = async work => { try { return await work(); } catch (error) { if (error instanceof AuthError) throw new ToolRefusal(error.code); throw error; } };
 return [
  defineTool({ name: 'fixture.workspace.snapshot', title: 'Inspect native workspace state', description: 'Witness native records, receipts and operator authority.', scope: 'records:read', readOnly: true,
   inputSchema: object({}), outputSchema: object({ records: { type: 'object' }, operators: { type: 'array', items: { type: 'object' } } }), classes: ['standard'], clauses,
   classify: () => [{ class: 'standard', facts: { measure: 1 } }],
   async run(_args, ctx) { return { result: { records: await records.list(ctx.person), operators: (await db.prepare('SELECT id,role,status,version FROM oa_operators ORDER BY id').all()).results } }; } }),
  defineTool({ name: 'fixture.access.invite', title: 'Invite a teammate', description: 'Grant pending access through native operator administration.', scope: 'access:write', readOnly: false,
   inputSchema: object({ email: text, name: text, role }), outputSchema: result, classes: ['external', 'access'], clauses,
   authority: async args => ({ subject: args.email, widens: true }),
   classify: () => [{ class: 'external', facts: { measure: 1, counterparty: 'new' } }, { class: 'access', facts: { measure: 1, direction: 'widens' } }],
   summary: args => ({ target: { email: args.email, name: args.name }, recipients: [args.email], role: args.role }),
   async run(args, ctx) {
    await act(() => commands(ctx).invite({ email: args.email, displayName: args.name, role: args.role, returnTo: '/app' }));
    const row = await db.prepare('SELECT id,role,status,version FROM oa_operators WHERE email=?').bind(args.email).first();
    ctx.emit('operator.invited', `fixture://operator/${row.id}`); return { result: row };
   } }),
  defineTool({ name: 'fixture.access.role', title: 'Change teammate authority', description: 'Widen or narrow a teammate through native delegated administration.', scope: 'access:write', readOnly: false,
   inputSchema: object({ id: text, role }), outputSchema: result, classes: ['access'], clauses,
   authority: async args => ({ subject: args.id, widens: args.role === 'admin' }),
   classify: args => [{ class: 'access', facts: { measure: 1, direction: args.role === 'admin' ? 'widens' : 'narrows' } }],
   summary: async args => ({ target: { id: args.id, name: (await read(args.id))?.name }, role: args.role }),
   async run(args, ctx) {
    const row = await act(() => commands(ctx).setRole(args.id, args.role));
    ctx.emit('operator.role.changed', `fixture://operator/${row.id}`); return { result: { id: row.id, role: row.role, status: row.status, version: row.version } };
   } }),
 ];
}
