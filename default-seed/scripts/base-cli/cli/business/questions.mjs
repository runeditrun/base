import { randomUUID } from 'node:crypto';
import { Api, identifier } from './api.mjs';
import { sensitive } from './detector.mjs';
import { paired, revokedByServer, revokedText } from './local-commands.mjs';
import { applyChoices } from './choices.mjs';
import { businessCommand } from './invocation.mjs';
import { titledVendor, keyStep, vendorNames, vendorHandle } from './vendor-door.mjs';

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

// What this computer is waiting for, in the owner's terms. Until its own
// folder scan has finished, that is the owner's scan permission for the folder
// connect ran in; afterwards it is the owner's next step in the browser.
export function waitingFor(state) {
 if (!state.discovered) {
  const folder = state.workingFolder ?? process.cwd();
  return `Waiting for the owner to allow scanning ${folder} (names only). They allow it on Your tools: ${ownerLink(state)}/tools`;
 }
 return `Waiting for the next task. Nothing needs this computer until the owner moves the plan forward: ${ownerLink(state)}`;
}
const runWork = { 'discover.local': "this computer's names-only scan of the folders the owner allowed" };
// The vendor tasks run performs into an app's import door, and what each one is, in the owner's terms.
const vendorSteps = {
 'export.vendor': name => `export the owner's ${name} history into its app's import door. It lands as a preview: nothing changes in the app until the owner approves it in the browser.`,
 'catchup.vendor': name => `bring the owner's recent ${name} changes into its app's import door as a catch-up. Within the owner's standing catch-up approval Business applies it; anything larger waits for the owner's approval in the browser.`,
 'switchoff.archive': name => `archive the owner's final ${name} export in its app's import door. The app keeps the exact file in its own storage and test-restores it with no writes; cancelling ${name} stays the owner's step.`,
};
const vendorStep = task => Object.hasOwn(vendorSteps, task.kind) && task.runner === 'executor' && ['ready', 'leased'].includes(task.state);
const agentQuestion = task => task.kind === 'classify.row' && task.runner === 'executor' && ['ready', 'leased'].includes(task.state);

// A move's owner steps: freezing the old tool, a rollback (its card when Business
// cannot undo the switch itself) and cancelling at the vendor. Each happens in the
// browser and is never this computer's agent work.
const moveSteps = {
 'freeze.vendor': name => `freeze ${name} (pause changes in it as the move page lists), then confirm the freeze there`,
 rollback: () => 'follow the rollback card for this switch on the move page (Business undoes what it can itself and checks the rest)',
 'switchoff.cancel': name => `cancel ${name} at the vendor once the move is ready to cancel, then confirm it there (RER never contacts the vendor)`,
};
const moveStep = kind => typeof kind !== 'string' ? null : kind.startsWith('rollback.') ? moveSteps.rollback : ['freeze.vendor', 'switchoff.cancel'].includes(kind) ? moveSteps[kind] : null;
/** The move's page when the task names its tool, else the switch-over board (the Business home, which links each move). */
function moveLink(state, task) {
 const tool = typeof task.tool_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,399}$/.test(task.tool_id) && !sensitive(task.tool_id) ? task.tool_id : null;
 return tool ? `${ownerLink(state)}/moves/${encodeURIComponent(tool)}` : ownerLink(state);
}
/** A move's owner step in plain words with its link, or null. The vendor is named from a closed local table. */
export function ownerStep(task, state) {
 const step = moveStep(task.kind);
 if (!step) return null;
 const vendor = titledVendor(task.kind, task.title);
 return { words: step(vendor ? vendorNames[vendor] : 'the old tool'), link: moveLink(state, task) };
}
/** The owner steps of moves that Business lists, as what this computer waits for. */
export function ownerWaiting(tasks, state) {
 return [...new Set(tasks.map(task => ownerStep(task, state)).filter(Boolean).map(step => `Waiting for the owner to ${step.words}: ${step.link}`))];
}

/** Agent steps that wait on this computer but not on run itself, in plain words. */
export function agentWaiting(tasks) {
 return tasks.some(agentQuestion) ? [`A question waits for this computer's agent. Answer it with: ${businessCommand('next')}`] : [];
}

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
 const { state, credential } = await paired(), api = new Api(state.origin, credential);
 let tasks;
 try {
  // Each check-in applies the owner's latest choices for this computer.
  await applyChoices(api, state);
  tasks = await nextQuestions(api, signal);
 } catch (error) {
  if (error.status !== 401) throw error;
  throw Error(`Business pairing expired or was revoked. This computer was ${revokedText(await revokedByServer(state))}`);
 }
 // This computer's agent hears its own steps first, then the owner's.
 const item = tasks.find(task => task.kind === 'classify.row' || vendorStep(task)) ?? tasks.find(task => task.runner === 'owner' || ownerKinds.has(task.kind) || moveStep(task.kind));
 if (!item) {
  // Nothing to answer here; say whether run has work, or what it waits for.
  const work = tasks.find(task => Object.hasOwn(runWork, task.kind) && task.state === 'ready');
  if (work) { process.stdout.write(`Ready for run: ${runWork[work.kind]}. Start it with: ${businessCommand('run')}\n`); return; }
  process.stdout.write(`${waitingFor(state)}\nNothing yet.\n`); return;
 }
 const id = identifier(item.task_id);
 if (sensitive(id)) throw Error('Business task identifier was refused by the outbound detector.');
 const step = ownerStep(item, state);
 if (step) {
  process.stdout.write(`Owner: ${id}\nOwner step, not this computer's agent work: ${step.words}.\nIn the browser: ${step.link}\n`); return;
 }
 if (item.runner === 'owner' || ownerKinds.has(item.kind)) {
  process.stdout.write(`Owner: ${id}\nAnswer in your browser: ${ownerLink(state)}\n`); return;
 }
 if (Object.hasOwn(vendorSteps, item.kind)) {
  // The vendor is named from a closed local table, never from server text.
  const vendor = titledVendor(item.kind, item.title), name = vendor ? vendorNames[vendor] : 'vendor';
  const stored = vendor && (state.vendorHandles ?? []).includes(vendorHandle(vendor));
  process.stdout.write(`Agent: ${id}\nStep: ${vendorSteps[item.kind](name)}\n`
   + (stored ? `Vendor key: the owner's read-only ${name} key is stored in this computer's OS credential storage. To replace it, ${keyStep(vendor)}\n`
    : `Vendor key: ${keyStep(vendor)}${vendor ? '' : `\n  where <vendor> is the tool this step reads: ${Object.keys(vendorNames).join(' | ')}`}\n`)
   + `Then run: ${businessCommand('run')}\n`);
  return;
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
 if (summary.runner === 'owner' || ownerKinds.has(summary.kind) || moveStep(summary.kind)) throw Error(`This item requires the owner in the browser: ${ownerStep(summary, state)?.link ?? ownerLink(state)}`);
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
