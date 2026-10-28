// This key and provider credential belong only to this disposable test fixture.
// The app and receiver still use the complete authenticated delivery protocol.
const DELIVERY_SECRET = 'fixture-only-delivery-hmac-key-never-use-outside-tests';
export const OPENAI_AUTHORIZATION = 'Bearer fixture-paid-network-edge-only';
const encode = value => new TextEncoder().encode(value);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const bytes = value => Uint8Array.from(value.match(/../g) ?? [], part => Number.parseInt(part, 16));
const key = () => crypto.subtle.importKey('raw', encode(DELIVERY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function sign(value) { return hex(await crypto.subtle.sign('HMAC', await key(), encode(value))); }
async function verify(value, signature) {
  return typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature)
    && crypto.subtle.verify('HMAC', await key(), bytes(signature), encode(value));
}
export async function deliveryRequest(record, deliveryId) {
  const body = JSON.stringify({ deliveryId, recordId: record.id, value: record.value });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request('https://receiver.example.invalid/deliveries', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
      'x-delivery-timestamp': timestamp, 'x-delivery-signature': await sign(`POST\n/deliveries\n${timestamp}\n${body}`) }, body,
  });
}
export async function verifyDeliveryReceipt(document, { deliveryId, recordId, value }) {
  const receipt = document?.receipt;
  const digest = hex(await crypto.subtle.digest('SHA-256', encode(value)));
  return receipt?.deliveryId === deliveryId && receipt.recordId === recordId && receipt.accepted === true
    && receipt.digest === digest && await verify(`receipt\n${JSON.stringify(receipt)}`, document.signature);
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== 'https://receiver.example.invalid' || url.pathname !== '/deliveries' || url.search || request.method !== 'POST') return new Response('Unsupported delivery', { status: 404 });
    if (request.headers.get('content-type') !== 'application/json' || request.headers.get('accept') !== 'application/json') return new Response('Invalid delivery headers', { status: 400 });
    const timestamp = request.headers.get('x-delivery-timestamp'), body = await request.text();
    if (!/^\d+$/.test(timestamp ?? '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
      || !await verify(`POST\n/deliveries\n${timestamp}\n${body}`, request.headers.get('x-delivery-signature'))) return new Response('Invalid signature', { status: 401 });
    let input;
    try { input = JSON.parse(body); } catch { return new Response('Invalid delivery', { status: 400 }); }
    if (!input || Object.keys(input).sort().join(',') !== 'deliveryId,recordId,value'
      || ['deliveryId', 'recordId', 'value'].some(field => typeof input[field] !== 'string' || !input[field])) return new Response('Invalid delivery', { status: 400 });
    const receipt = { deliveryId: input.deliveryId, recordId: input.recordId, accepted: true,
      digest: hex(await crypto.subtle.digest('SHA-256', encode(input.value))) };
    return Response.json({ receipt, signature: await sign(`receipt\n${JSON.stringify(receipt)}`) }, { status: 202 });
  },
};
