import { VendorExportError, fail } from './common.mjs';
import { originOf } from './zendesk-token.mjs';
import { transport } from './zendesk-transport.mjs';
import { ZendeskStore, materialize } from './zendesk-store.mjs';
import { tickets, comments } from './zendesk-tickets.mjs';
import { people } from './zendesk-people.mjs';
import { guide } from './zendesk-guide.mjs';
import { attachments } from './zendesk-attachments.mjs';
import { encodeSnapshot } from './zendesk-encode.mjs';

export { originOf } from './zendesk-token.mjs';
export { clientCredential } from './zendesk-token.mjs';
export { storePath, removeZendeskStores } from './zendesk-store.mjs';
/** The durable local snapshot is independent of door transfer. A new task
 * starts a fresh snapshot or extends the complete retained store for a sweep;
 * retries of the same task resume its last acknowledged page. */
export async function snapshot({ key, inputs, directory, runId, signal }) {
 try {
  const origin = originOf(inputs);
  if (!directory || typeof runId !== 'string' || !runId || inputs.mode === 'retire') fail('INVALID_INPUT');
  const store = await new ZendeskStore(directory).start();
  const mode = inputs.mode ?? 'snapshot', baseline = await store.baseline();
  if (mode === 'sweep' && store.state?.runId !== runId && (!baseline || inputs.highWater !== baseline.highWater)) fail('INVALID_HIGH_WATER');
  if (store.state?.runId !== runId) {
   if (mode === 'sweep' && store.state?.phase !== 'done') fail('INCOMPLETE_SNAPSHOT');
   await store.reset({ phase: 'A', path: null, index: 0, attachmentIndex: 0, stage: 0, runId, origin, mode, inputHighWater: inputs.highWater ?? null,
    exportedAt: new Date().toISOString(), bytes: mode === 'sweep' ? store.state.bytes : 0, requests: 0 }, { retain: mode === 'sweep' });
  } else if (store.state.origin !== origin || store.state.mode !== mode || store.state.inputHighWater !== (inputs.highWater ?? null)) fail('INVALID_CHECKPOINT');
  store.requestTotal = store.state.requests;
  const ctx = { store, inputs, ...await transport({ inputs, key, signal, beforeRequest: async () => {
   if (store.requestTotal >= 250_000) fail('REQUEST_LIMIT');
   store.requestTotal++;
   await store.commit(store.state);
  } }) };
  while (store.state.phase !== 'done') {
   signal?.throwIfAborted();
   const phase = store.state.phase;
   if (phase === 'A') await tickets(ctx);
   else if (phase === 'B') await comments(ctx);
   else if (['C','D','E'].includes(phase)) await people(ctx);
   else if (phase === 'F') await guide(ctx);
   else if (['attachments', 'guide_attachments'].includes(phase)) await attachments(ctx);
   else fail('INVALID_CHECKPOINT');
  }
  if (mode === 'census') {
   const data = await materialize(store), unswept = [...data.tickets.values()].filter(({ row }) => row.generated_timestamp > (inputs.highWater ?? 0)).length;
   const census = { format: 'rer-zendesk-census/1', tickets: { unique: data.tickets.size, deleted: [...data.tickets.values()].filter(({row}) => row.status === 'deleted' || row.deleted).length }, unswept, highWater: data.highWater };
   await store.write('census.json', census);
   return { kind: 'census', census, store };
  }
  const result = await encodeSnapshot(store, { origin });
  if (store.state.highWater !== result.census.highWater) await store.commit({ ...store.state, highWater: result.census.highWater });
  await store.write('census.json', result.census);
  await store.write('baseline.json', { highWater: result.census.highWater, head: store.head });
  return { ...result, store };
 } catch (error) {
  if (error instanceof VendorExportError) throw error;
  throw new VendorExportError(signal?.aborted ? 'CANCELLED' : 'INVALID_EXPORT');
 }
}
