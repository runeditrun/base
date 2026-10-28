import { randomUUID } from 'node:crypto';

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
 return new Response('Conformance has no network adapter for this external effect.', { status: 502 });
}
