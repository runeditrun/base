import { defineTool } from '../../../../modules/agent-door/index.ts';

const text = { type: 'string', minLength: 1 };
const target = { type: 'object', properties: { team_id: text, operator_id: text }, required: ['team_id', 'operator_id'], additionalProperties: false };
const classes = ['access'], clauses = ['BASE-AGENT-005'];

export function compositeTools(db, records) {
 const authorize = async (args, ctx) => { await records.read(args.team_id, ctx.person); };
 return [
  defineTool({ name: 'fixture.members.prepare', title: 'Prepare native memberships', description: 'Grant one team member and neighboring memberships.', scope: 'access:write', readOnly: false, classes, clauses,
   inputSchema: target, outputSchema: target, authority: args => ({ subject: args.operator_id, widens: true }), classify: () => [{ class: 'access', facts: { measure: 1, direction: 'widens' } }], summary: args => ({ target: { id: args.operator_id } }),
   async run(args, ctx) {
    await authorize(args, ctx);
    await db.batch([[args.team_id, args.operator_id], [args.team_id, 'another-member'], ['another-team', args.operator_id]].map(([team, person]) => db.prepare('INSERT OR IGNORE INTO fixture_team_grants(team_id,operator_id,scope) VALUES(?,?,?)').bind(team, person, 'records:read')));
    ctx.emit('membership.created', `fixture://team/${args.team_id}`); return { result: args };
   } }),
  defineTool({ name: 'fixture.members.revoke', title: 'Remove native team member', description: 'Revoke only the named team and member tuple.', scope: 'access:write', readOnly: false, classes, clauses, widens: false, narrowing: { effect: 'revoke', target: ['team_id', 'operator_id'] },
   inputSchema: target, outputSchema: target, authority: args => ({ subject: args.operator_id, widens: false }), classify: () => [{ class: 'access', facts: { measure: 1, direction: 'narrows' } }], summary: args => ({ target: { id: args.operator_id } }),
   async run(args, ctx) {
    await authorize(args, ctx);
    await db.prepare('DELETE FROM fixture_team_grants WHERE team_id=? AND operator_id=?').bind(args.team_id, args.operator_id).run();
    ctx.emit('membership.revoked', `fixture://team/${args.team_id}`); return { result: args };
   } }),
  defineTool({ name: 'fixture.members.grants', title: 'Read native team member grants', description: 'Witness the exact tuple and its unchanged neighbors.', scope: 'records:read', readOnly: true, classes: ['standard'], clauses,
   inputSchema: target, outputSchema: { type: 'object', properties: { grants: { type: 'array', items: text }, neighbors: { type: 'integer' } }, required: ['grants', 'neighbors'], additionalProperties: false }, classify: () => [{ class: 'standard', facts: { measure: 1 } }],
   async run(args, ctx) {
    await authorize(args, ctx);
    const grants = (await db.prepare('SELECT scope FROM fixture_team_grants WHERE team_id=? AND operator_id=? ORDER BY scope').bind(args.team_id, args.operator_id).all()).results.map(row => row.scope);
    const neighbors = await db.prepare('SELECT COUNT(*) AS count FROM fixture_team_grants WHERE (team_id=? AND operator_id=?) OR (team_id=? AND operator_id=?)').bind(args.team_id, 'another-member', 'another-team', args.operator_id).first();
    return { result: { grants, neighbors: neighbors.count } };
   } }),
 ];
}
