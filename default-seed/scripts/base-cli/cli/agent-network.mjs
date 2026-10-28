import { randomUUID } from 'node:crypto';
import { validateNetworkAdapter, NetworkAdapterError } from '../modules/agent-door/conformance/network-modules.mjs';
import { isolatedNetworkAdapter } from '../modules/agent-door/conformance/network-runtime.mjs';
import { RerError } from './errors.mjs';

const denied = () => new Response('Conformance has no network adapter for this external effect.', { status: 502 });
const addresses = value => (Array.isArray(value) ? value : [value]).map(item => typeof item === 'string' ? item : item?.email).filter(item => typeof item === 'string').map(item => (/<([^<>]+)>\s*$/.exec(item)?.[1] ?? item).trim().toLowerCase());
async function message(request) {
 try { return await request.json(); } catch { return null; }
}

/** Mail this run's disposable installation sent, readable only by the seed's declared test tooling. */
export function conformanceMailbox() {
 const messages = [];
 return { record(to, text) { messages.push({ to, text: String(text ?? '') }); },
  latest(address) { return messages.findLast(item => item.to.includes(String(address).trim().toLowerCase()))?.text ?? null; } };
}

// Conformance is a disposable installation. Replace only the paid mail network
// edge; native invitation preparation, authorization and D1 commits still run.
// No request leaves this verifier and no stand-in credential reaches a provider.
export const agentConformanceNetwork = request => mailEdge(request);
async function mailEdge(request, mail) {
 const url = new URL(request.url);
 if (request.method === 'POST' && url.origin === 'https://api.resend.com' && url.pathname === '/emails') {
  const body = await message(request);
  mail?.record(addresses(body?.to), body?.text);
  return Response.json({ id: randomUUID() });
 }
 if (request.method === 'POST' && url.origin === 'https://api.sendgrid.com' && url.pathname === '/v3/mail/send') {
  const body = await message(request);
  mail?.record(addresses((body?.personalizations ?? []).flatMap(item => item?.to ?? [])), body?.content?.find(item => item?.type === 'text/plain')?.value);
  return new Response(null, { status: 202, headers: { 'x-message-id': randomUUID() } });
 }
 if (request.method === 'POST' && url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\/[^/]+\/email\/sending\/send$/.test(url.pathname)) {
  const body = await request.json();
  mail?.record(addresses(body.to), body.text);
  return Response.json({ success: true, errors: [], result: { message_id: randomUUID(), accepted: body.to, rejected: [] } });
 }
 return denied();
}

/** Extend the paid network edge for declared origins, without running seed
 * modules in this process or giving them any route to the real network. */
export async function createAgentConformanceNetwork(root, config) {
 const mail = conformanceMailbox(), edge = request => mailEdge(request, mail);
 if (config === undefined) return { fetch: edge, mail, close: async () => {} };
 let declaration, adapter;
 try {
  declaration = validateNetworkAdapter(config);
  adapter = await isolatedNetworkAdapter(root, declaration.module, denied);
 } catch (error) {
  if (error instanceof NetworkAdapterError) throw new RerError('agent_network_invalid', error.message, 1);
  throw error;
 }
 return { close: adapter.close, mail, fetch: async request => {
  if (!declaration.origins.has(new URL(request.url).origin)) return edge(request);
  try { return await adapter.fetch(request); }
  catch { throw new RerError('agent_network_failed', 'The isolated conformance network adapter failed to handle a provider request. Its default fetch export must return a Response.', 1); }
 } };
}
