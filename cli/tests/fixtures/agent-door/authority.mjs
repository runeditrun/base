import { defineTool, ToolRefusal } from '../../../../modules/agent-door/index.ts';

const text = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const idInput = object({ id: text });

export function authorityTools(db, records) {
 const grantSet = async (id, person) => {
  await records.authorize(person);
  return (await db.prepare('SELECT scope FROM fixture_grants WHERE id=? AND operator_id=? ORDER BY scope').bind(id, person.id).all()).results.map(row => row.scope);
 };
 const definition = { scope: 'access:write', readOnly: false, classes: ['access'], clauses: ['BASE-AGENT-005'], outputSchema: idInput,
  summary: args => ({ target: { id: args.id } }) };
 return [
  defineTool({ ...definition, name: 'fixture.access.grant', title: 'Grant record access', description: 'Add native record authority to a subject.', inputSchema: object({ id: text, scope: { type: 'string', enum: ['records:read'] } }),
   authority: async args => ({ subject: args.id, widens: true }), classify: () => [{ class: 'access', facts: { measure: 1, direction: 'widens' } }],
   async run(args, ctx) {
    await records.read(args.id, ctx.person);
    await db.prepare('INSERT INTO fixture_grants(id,scope,operator_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(args.id, args.scope, ctx.person.id).run();
    ctx.emit('grant.added', `fixture://grant/${args.id}`); return { result: { id: args.id } };
   } }),
  defineTool({ ...definition, name: 'fixture.access.revoke', title: 'Revoke record access', description: 'Remove all native grants from one subject.', inputSchema: idInput, widens: false, narrowing: { effect: 'revoke', target: 'id' },
   authority: async args => ({ subject: args.id, widens: false }), classify: () => [{ class: 'access', facts: { measure: 1, direction: 'narrows' } }],
   async run(args, ctx) {
    await records.read(args.id, ctx.person);
    await db.prepare('DELETE FROM fixture_grants WHERE id=? AND operator_id=?').bind(args.id, ctx.person.id).run();
    ctx.emit('grant.revoked', `fixture://grant/${args.id}`); return { result: { id: args.id } };
   } }),
  defineTool({ name: 'fixture.access.grants', title: 'Read native grants', description: 'Read the targeted subject native grant set.', scope: 'records:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-005'], inputSchema: idInput, outputSchema: object({ grants: { type: 'array', items: text } }),
   classify: () => [{ class: 'standard', facts: { measure: 1 } }], async run(args, ctx) { return { result: { grants: await grantSet(args.id, ctx.person) } }; } }),
  defineTool({ name: 'fixture.records.protected', title: 'Confirm native record', description: 'Confirm a record only after recent native human proof.', scope: 'records:write', readOnly: false, classes: ['sensitive'], clauses: ['BASE-AGENT-004'], inputSchema: idInput, outputSchema: idInput,
   proof: 'native', proofKind: 'step_up', summary: args => ({ target: { id: args.id } }), classify: () => [{ class: 'sensitive', facts: { measure: 1, kind: 'personal' } }],
   async run(args, ctx) {
    await records.read(args.id, ctx.person);
    if (ctx.nativeProof?.kind !== 'step_up') throw new ToolRefusal('native_proof_required');
    await db.prepare("UPDATE fixture_records SET value=value||' confirmed',version=version+1 WHERE id=? AND operator_id=?").bind(args.id, ctx.person.id).run();
    ctx.emit('record.confirmed', `fixture://record/${args.id}`); return { result: { id: args.id } };
   } }),
 ];
}

// Disposable seed-owned verifier: recent human session admission issues an
// opaque, expiring reference bound to person, originating agent and exact action.
export async function issueProof(db, person, { tool, id, agentId }) {
 if (tool !== 'fixture.records.protected' || typeof id !== 'string' || typeof agentId !== 'string') throw new ToolRefusal('invalid_arguments');
 const reference = crypto.randomUUID();
 await db.prepare('INSERT INTO fixture_proofs VALUES(?,?,?,?,?,?)').bind(reference, person.id, agentId, tool, id, Date.now() + 60000).run();
 return reference;
}
export function nativeProof(db) {
 return {
  handoff: () => '/app/native-proof',
  async verify({ kind, tool, args, principal, reference }) {
   const saved = await db.prepare('SELECT * FROM fixture_proofs WHERE id=?').bind(reference).first();
   return kind === 'step_up' && saved?.operator_id === principal.person.id && saved?.agent === principal.agent.id && saved?.tool === tool && saved?.record_id === args.id && saved?.expires > Date.now();
  },
 };
}
