import { randomUUID } from 'node:crypto';
import { validateNetworkAdapter, NetworkAdapterError } from '../modules/agent-door/conformance/network-modules.mjs';
import { isolatedNetworkAdapter } from '../modules/agent-door/conformance/network-runtime.mjs';
import { verificationSecrets } from './agent-secrets.mjs';
import { RerError } from './errors.mjs';
import { createCapturedMail } from './agent-mail.mjs';
import { createFixtureControl } from './agent-fixtures.mjs';

const denied = () => new Response('Conformance has no network adapter for this external effect.', { status: 502 });

// Conformance is a disposable installation. Replace only the paid mail network
// edge; native invitation preparation, authorization and D1 commits still run.
// No request leaves this verifier and no stand-in credential reaches a provider.
export async function agentConformanceNetwork(request) {
 const url = new URL(request.url);
 if (request.method === 'POST' && url.origin === 'https://api.resend.com' && url.pathname === '/emails') {
  await request.arrayBuffer();
  return Response.json({ id: randomUUID() });
 }
 if (request.method === 'POST' && url.origin === 'https://api.sendgrid.com' && url.pathname === '/v3/mail/send') {
  await request.arrayBuffer();
  return new Response(null, { status: 202, headers: { 'x-message-id': randomUUID() } });
 }
 if (request.method === 'POST' && url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\/[^/]+\/email\/sending\/send$/.test(url.pathname)) {
  const body = await request.json();
  return Response.json({ success: true, errors: [], result: { message_id: randomUUID(), accepted: body.to, rejected: [] } });
 }
 return denied();
}

/** Extend the paid network edge for declared origins, without running seed
 * modules in this process or giving them any route to the real network. */
export async function createAgentConformanceNetwork(root, config, { email } = {}) {
 const mail = createCapturedMail(email);
 let declaration, adapter, fixtures;
 try {
  if (config !== undefined) {
   const network = config && typeof config === 'object' && !Array.isArray(config) ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'secretSource')) : config;
   declaration = validateNetworkAdapter(network);
   adapter = await isolatedNetworkAdapter(root, declaration.module, denied);
  }
  fixtures = createFixtureControl(declaration?.origins ?? new Set());
 } catch (error) {
  mail.close();
  if (error instanceof NetworkAdapterError) throw new RerError('agent_network_invalid', error.message, 1);
  throw error;
 }
 return { provision: async hosted => {
   if (config?.secretSource === undefined) return {};
   const secrets = await verificationSecrets(root, config.secretSource, hosted.database);
   await adapter.provision(secrets);
   return secrets;
  }, mail: { read: options => mail.read(options) }, fixtures: { set: (origin, value) => fixtures.set(origin, value) },
 close: async () => { mail.close(); fixtures.close(); await adapter?.close(); }, fetch: async request => {
  const capture = request.clone(), origin = new URL(request.url).origin;
  try {
   const response = declaration?.origins.has(origin) ? await adapter.fetch(request, fixtures.get(origin)) : await agentConformanceNetwork(request);
   if (response.ok) await mail.capture(capture);
   else void capture.body?.cancel();
   return response;
  }
  catch { void capture.body?.cancel(); throw new RerError('agent_network_failed', 'The isolated conformance network adapter failed to handle a provider request. Its default fetch export must return a Response.', 1); }
 } };
}
