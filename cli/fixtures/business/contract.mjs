// Network-edge validation copied from the merged platform contract, not from
// the CLI implementation. Invalid requests must fail before mutating state.
export const usage = ['uses', 'sells', 'both', 'product-dependency'];
export const reasons = ['handover', 'paused', 'cancelled', 'failed'];
export function requireValue(condition, status = 400, reason) {
 if (!condition) throw Object.assign(Error('Fixture contract rejected the request'), { status, reason });
}
export function object(value) {
 requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
 return value;
}
export function closed(value, allowed) {
 object(value); requireValue(Object.keys(value).every(key => allowed.includes(key)));
}
export function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
 requireValue(Number.isSafeInteger(value) && value >= 0 && value <= maximum);
}
export function identifier(value) {
 requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,399}$/.test(value));
}
export function eventId(value) {
 requireValue(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value));
}
export function checkpoint(value, mcp = false) {
 const numbers = mcp ? ['records_done', 'bytes_done', 'progress'] : ['page', 'total', 'records_done', 'bytes_done', 'progress'];
 closed(value, [...numbers, 'status', 'question', ...(mcp ? [] : ['chunk_hashes'])]);
 for (const key of numbers) if (value[key] !== undefined) integer(value[key], mcp && key === 'progress' ? 100 : Number.MAX_SAFE_INTEGER);
 if (value.status !== undefined) requireValue(['running', 'paused', 'needs_input', 'failed'].includes(value.status));
 if (value.question !== undefined) requireValue(['owner_required', 'configuration_required', 'consent_required', 'connected_runner_required'].includes(value.question));
 if (value.chunk_hashes !== undefined) requireValue(Array.isArray(value.chunk_hashes) && value.chunk_hashes.length <= 200 && value.chunk_hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
 requireValue(JSON.stringify(value).length <= 32_768);
}
export function actionBody(action, body, mcp = false) {
 const extras = { claim: [], heartbeat: ['checkpoint', 'cursor'], events: ['event'], complete: ['outputs'], release: ['checkpoint', 'reason'], uploads: ['consent_id', 'document'] };
 requireValue(Object.hasOwn(extras, action));
 closed(body, ['client_event_id', 'fence', ...(action === 'claim' ? [] : ['grant_id']), ...extras[action]]);
 eventId(body.client_event_id); integer(body.fence);
 if (action !== 'claim') identifier(body.grant_id);
 if (body.checkpoint !== undefined) checkpoint(body.checkpoint, mcp);
 if (body.cursor !== undefined) integer(body.cursor);
 if (body.reason !== undefined) requireValue(reasons.includes(body.reason));
 if (body.outputs !== undefined) object(body.outputs);
 if (action === 'events') {
  closed(body.event, ['kind', 'payload']);
  requireValue(['progress', 'question', 'status'].includes(body.event.kind));
  checkpoint(body.event.payload, true);
 }
}
export function classificationOutput(value, schema) {
 closed(value, ['vendor_id', 'usage', 'confidence']);
 requireValue(Object.keys(value).length === 3);
 requireValue(schema?.type === 'object' && schema.additionalProperties === false);
 requireValue(schema.properties?.vendor_id?.enum?.includes(value.vendor_id));
 requireValue(usage.includes(value.usage) && schema.properties?.usage?.enum?.includes(value.usage));
 requireValue(Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1);
}
/** An export.vendor completion (platform business/imports.ts exportOutputs):
 * exactly the door's upload_id and plan_id and the bundle's SHA-256. */
export function exportOutputs(value) {
 const id = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
 requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === 'bundle_sha256,plan_id,upload_id', 409, 'business_export_outputs_required');
 requireValue(typeof value.upload_id === 'string' && id.test(value.upload_id) && typeof value.plan_id === 'string' && id.test(value.plan_id)
  && typeof value.bundle_sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.bundle_sha256), 400, 'business_export_outputs_invalid');
 return value;
}
