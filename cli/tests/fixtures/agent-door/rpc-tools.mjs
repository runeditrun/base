import { defineTool, ToolRefusal } from '../../../../modules/agent-door/index.ts';
import { deliveryRequest, verifyDeliveryReceipt } from './receiver.mjs';
import { deliverySecret } from './credentials.mjs';

export function rpcTools(env, records) {
 return [defineTool({ name: 'fixture.records.dispatch', title: 'Dispatch record through RPC', description: 'Deliver a signed native record using the egress RPC service.', scope: 'records:write', readOnly: false,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, outputSchema: { type: 'object', properties: { verified: { type: 'boolean' } }, required: ['verified'], additionalProperties: false },
  classes: ['external'], clauses: ['BASE-AGENT-006'], classify: () => [{ class: 'external', facts: { measure: 1, counterparty: 'known' } }], summary: args => ({ target: { id: args.id }, recipients: ['https://receiver.example.invalid'] }),
  async run(args, ctx) {
   const record = await records.read(args.id, ctx.person), deliveryId = crypto.randomUUID();
   const request = await deliveryRequest(record, deliveryId, deliverySecret);
   const delivered = await env.FIXTURE_EGRESS.send({ body: await request.text(), headers: Object.fromEntries(request.headers) });
   if (delivered.status !== 202 || !await verifyDeliveryReceipt(delivered.body, { deliveryId, recordId: record.id, value: record.value }, deliverySecret)) throw new ToolRefusal('rpc_delivery_failed');
   await records.receipt(record, ctx.person, 'rpc', delivered.status, delivered.body, deliveryId);
   ctx.emit('record.dispatched', `fixture://record/${record.id}`);
   return { result: { verified: true } };
  },
 })];
}
