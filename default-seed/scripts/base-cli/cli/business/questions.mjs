import { randomUUID } from 'node:crypto';
import { Api, identifier } from './api.mjs';
import { sensitive } from './detector.mjs';
import { paired } from './local-commands.mjs';
import { applyOptIns } from './opt-ins.mjs';

const protocolVersion = '2025-11-25';
const headers = { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion };
export const classifications = ['uses', 'sells', 'both', 'product-dependency'];

export async function mcpClient(api, { taskId, signal } = {}) {
 const minted = await api.mintToken('mcp', { taskId, signal });
 const options = { token: minted.access_token, signal, headers };
 let sequence = 0;
 async function rpc(method, params, notification = false) {
  const result = await api.post('/api/business/mcp', { jsonrpc: '2.0', ...(!notification ? { id: ++sequence } : {}), method, params }, options);
  if (notification) return;
  if (!result || result.error || result.id !== sequence) throw Error('Business MCP operation was refused.');
  return result.result;
 }
 const initialized = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'rer-business', version: '1.0.0' } });
 if (initialized.protocolVersion !== protocolVersion) throw Error('Business MCP protocol revision is unsupported.');
 await rpc('notifications/initialized', {}, true);
 return async (name, args = {}) => {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError || !result?.structuredContent) throw Error('Business task action is unavailable. Use the browser to check its requirements.');
  return result.structuredContent;
 };
}

export async function nextQuestions(api, signal) {
 const tool = await mcpClient(api, { signal });
 const result = await tool('next_question');
 if (!Array.isArray(result.tasks)) throw Error('Business server returned invalid task summaries.');
 return result.tasks;
}
const ownerKinds = new Set(['signup.checkout','connect.cloudflare','connect.github','consent.grant','confirm.inventory','plan.review','wave.approve','switchoff.cancel','cutover.billing','rollback.billing']);
export const ownerLink = state => `${state.origin}/business/${encodeURIComponent(identifier(state.businessId))}`;

function classification(task) {
 const toolId = identifier(task.question?.tool_id), vendorId = task.question?.vendor_id;
 const schema = task.question?.answer_schema, vendors = schema?.properties?.vendor_id?.enum;
 const usages = schema?.properties?.usage?.enum;
 if (!Array.isArray(vendors) || !vendors.length || vendors.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(value) || sensitive(value))
  || !vendors.includes('none') || !vendors.includes(vendorId) || sensitive(toolId)
  || !Array.isArray(usages) || usages.length !== classifications.length || classifications.some(value => !usages.includes(value))
  || schema.properties.confidence?.type !== 'number' || schema.properties.confidence.minimum !== 0 || schema.properties.confidence.maximum !== 1)
  throw Error('Business classification metadata was refused.');
 return { toolId, vendorId, vendors };
}

export async function next() {
 const signal = AbortSignal.timeout(55_000);
 const { state, credential } = await paired();
 const api = new Api(state.origin, credential);
 await applyOptIns(api, state, { report: false });
 const tasks = await nextQuestions(api, signal);
 const item = tasks.find(task => task.kind === 'classify.row' || task.runner === 'owner' || ownerKinds.has(task.kind));
 if (!item) { process.stdout.write('Nothing yet.\n'); return; }
 const id = identifier(item.task_id);
 if (sensitive(id)) throw Error('Business task identifier was refused by the outbound detector.');
 if (item.runner === 'owner' || ownerKinds.has(item.kind)) {
  process.stdout.write(`Owner: ${id}\nAnswer in your browser: ${ownerLink(state)}\n`); return;
 }
 const { toolId, vendorId, vendors } = classification(item);
 process.stdout.write(`Agent: ${id}\nTool: ${toolId}\nSuggested vendor: ${vendorId}\nVendors: ${vendors.join(' | ')}\nSuggest how this tool is used. The owner confirms in the browser.\nUsage: ${classifications.join(' | ')}\nRun: rer business answer ${id} <vendor_id|none> <usage> [confidence]\n`);
}

export async function answer(id, vendorId, choice, rawConfidence = '1') {
 identifier(id);
 // Reject free text before even looking up the question or minting a bearer.
 if (typeof vendorId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(vendorId) || sensitive(vendorId)) throw Error('Choose a catalog vendor id from rer business next, or none.');
 if (!classifications.includes(choice)) throw Error(`Choose an enum: ${classifications.join(', ')}.`);
 if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawConfidence)) throw Error('Choose a numeric confidence between 0 and 1.');
 const confidence = Number(rawConfidence);
 const { state, credential } = await paired(), api = new Api(state.origin, credential), signal = AbortSignal.timeout(55_000);
 const summary = await (await mcpClient(api, { signal }))('explain_task', { task_id: id });
 if (summary.runner === 'owner' || ownerKinds.has(summary.kind)) throw Error(`This item requires the owner in the browser: ${ownerLink(state)}`);
 if (summary.kind !== 'classify.row' || summary.runner !== 'executor') throw Error('This item does not accept a CLI classification answer.');
 const { vendors } = classification(summary);
 if (!vendors.includes(vendorId)) throw Error('Choose a catalog vendor id from this question, or none.');
 const tool = await mcpClient(api, { taskId: id, signal });
 let lease = summary;
 if (summary.state === 'ready') lease = await tool('answer', { task_id: id, action: 'claim', client_event_id: randomUUID(), fence: summary.fence });
 if (typeof lease.grant_id !== 'string') throw Error('Business did not return a grant for this question.');
 try {
  await tool('answer', { task_id: id, action: 'complete', client_event_id: randomUUID(), fence: lease.fence, grant_id: lease.grant_id, outputs: { vendor_id: vendorId, usage: choice, confidence } });
 } catch (error) {
  try { await tool('answer', { task_id: id, action: 'release', client_event_id: randomUUID(), fence: lease.fence, grant_id: lease.grant_id, reason: 'failed' }); } catch { /* Expiry/revocation still fences the lease. */ }
  throw error;
 }
 process.stdout.write('Business answer submitted for server validation.\n');
}

export async function token() {
 const { state, credential } = await paired();
 const result = await new Api(state.origin, credential).mintToken('mcp');
 // Claude headersHelper consumes this directly; never run this in an agent
 // transcript. Vendor credentials cannot be retrieved through this command.
 process.stdout.write(JSON.stringify({ Authorization: `Bearer ${result.access_token}` }) + '\n');
}
