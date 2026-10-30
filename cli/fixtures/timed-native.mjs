// A native fixture seed: a signed delivery ages, Cron materializes eligible
// work, and the public tool consumes it into a visible record exactly once.
import native from '../tests/fixtures/agent-door/worker.mjs';
import { createAgentDoor as create, ToolRefusal } from '../../modules/agent-door/index.ts';
export * from '../../modules/agent-door/index.ts';

export function createAgentDoor(options) {
 const db = options.db;
 return create({ ...options, tools: [...options.tools, {
  name: 'fixture.history.consume', title: 'Use an aged delivery', description: 'Create a record from native scheduled work for an aged signed delivery.',
  scope: 'records:write', readOnly: false, classes: ['standard'], clauses: ['BASE-AGENT-013'],
  inputSchema: { type: 'object', properties: { receiptId: { type: 'string' } }, required: ['receiptId'], additionalProperties: false },
  outputSchema: { type: 'object' }, classify: () => [{ class: 'standard', facts: { measure: 1 } }],
  summary: args => ({ target: { id: args.receiptId } }),
  async run(args, ctx) {
   const receipt = await db.prepare("SELECT r.value,r.operator_id FROM fixture_receipts s JOIN fixture_records r ON r.id=s.record_id JOIN fixture_history_ready h ON h.receipt_id=s.id WHERE s.id=? AND s.kind='delivery' AND s.created_at<=? AND r.operator_id=?").bind(args.receiptId, Date.now() - 3600000, ctx.person.id).first();
   if (!receipt) throw new ToolRefusal('native_history_not_ready');
   const id = crypto.randomUUID();
   await db.prepare('INSERT INTO fixture_records(id,value,version,operator_id) VALUES(?,?,1,?)').bind(id, receipt.value, receipt.operator_id).run();
   ctx.emit('record.created', 'fixture://record/' + id);
   return { result: { id, value: receipt.value, version: 1 } };
  },
 }] });
}

export default { ...native, async scheduled(controller, env) {
 await env.DB.prepare("INSERT INTO fixture_history_ready(receipt_id) SELECT id FROM fixture_receipts WHERE kind='delivery' AND created_at<=? ON CONFLICT DO NOTHING").bind(controller.scheduledTime - 3600000).run();
} };
