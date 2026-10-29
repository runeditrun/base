import { createAgentDoor, ToolRefusal } from '../../../../modules/agent-door/index.ts';

const text = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const standard = () => [{ class: 'standard', facts: { measure: 1 } }];

// Native persisted work retains its originating door admission. The dispatch
// tool re-enters a restricted Worker door after that admission has completed.
export function continuationTools(db, records, options, fabricate) {
 const common = { scope: 'records:write', readOnly: false, classes: ['standard'], clauses: ['BASE-AGENT-009'], classify: standard };
 return [
  { ...common, name: 'fixture.records.stage', title: 'Stage a record', description: 'Retain one record for native dispatch.',
   inputSchema: object({ value: text }), outputSchema: object({ id: text }), summary: args => ({ target: { name: args.value } }),
   async run(args, ctx) {
    await records.authorize(ctx.person);
    const id = crypto.randomUUID();
    const who = { person: { id: ctx.person.id }, agent: ctx.agent, scopes: ctx.scopes, consent: ctx.consent, clientId: ctx.clientId, operationId: ctx.operationId };
    await db.prepare('INSERT INTO fixture_jobs(id,input) VALUES(?,?)').bind(id, JSON.stringify({ value: args.value, who, key: ctx.idempotencyKey })).run();
    ctx.emit('record.staged', `fixture://staged/${id}`);
    return { result: { id } };
   } },
  { ...common, name: 'fixture.records.continue', title: 'Dispatch a staged record', description: 'Save one retained record through its originating native admission.',
   classes: ['external'], classify: () => [{ class: 'external', facts: { measure: 1, counterparty: 'known' } }],
   inputSchema: object({ id: text }), outputSchema: object({ id: text }), summary: args => ({ target: { id: args.id } }),
   async run(args, ctx) {
    await records.authorize(ctx.person);
    const item = await db.prepare('SELECT input,result FROM fixture_jobs WHERE id=?').bind(args.id).first();
    if (!item) throw new ToolRefusal('staged_record_not_found');
    const saved = JSON.parse(item.input);
    if (saved.who.person.id !== ctx.person.id) throw new ToolRefusal('staged_record_not_found');
    if (item.result) throw new ToolRefusal('staged_record_already_dispatched');
    const final = { ...common, name: 'fixture.records.continue', title: 'Save retained record', description: 'Complete a single native record item.',
     inputSchema: object({ id: text }), outputSchema: object({ id: text }),
     summary: () => ({ target: { id: args.id } }),
     continuationItem: () => ({ id: args.id, operationId: saved.who.operationId }),
     async run(_args, admitted) {
      const record = await records.create(saved.value, admitted.person);
      admitted.emit('record.created', `fixture://record/${record.id}`);
      return { result: { id: record.id } };
     },
    };
    const answer = await createAgentDoor({ ...options(), tools: [final] }).invoke(final.name, { id: args.id, idempotency_key: saved.key }, saved.who);
    if (answer.outcome !== 'done') throw new ToolRefusal(answer.code ?? 'native_dispatch_failed');
    await db.prepare('UPDATE fixture_jobs SET result=? WHERE id=?').bind(JSON.stringify(answer.result), args.id).run();
    if (fabricate) {
     const source = await db.prepare('SELECT row,evidence FROM agent_door_audit WHERE id=?').bind(answer.decision.id).first();
     const other = await db.prepare('SELECT agent_id FROM fixture_native_clients ORDER BY id LIMIT 1').first();
     const variants = [
      row => { delete row.continuation_item_id; },
      row => { row.operation_id = crypto.randomUUID(); },
      row => { row.agent.id = other.agent_id; },
      row => { row.sponsor.id = crypto.randomUUID(); },
      row => { row.consent = crypto.randomUUID(); },
      row => { row.client_id = crypto.randomUUID(); },
      row => { row.rules[0].rule = 'fabricated-policy-rule'; },
     ];
     for (const change of variants) {
      const row = { ...JSON.parse(source.row), id: crypto.randomUUID() };
      change(row);
      await db.prepare('INSERT INTO agent_door_audit(id,at,agent,classes,row,evidence) VALUES(?,?,?,?,?,?)')
       .bind(row.id, row.at, row.agent.id, JSON.stringify(row.classes.map(item => item.class)), JSON.stringify(row), source.evidence).run();
     }
    }
    return { result: answer.result };
   } },
 ];
}
