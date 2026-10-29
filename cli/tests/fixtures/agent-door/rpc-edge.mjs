import { WorkerEntrypoint } from 'cloudflare:workers';
import receiver from './receiver.mjs';
import { deliverySecret } from './credentials.mjs';

// A network-edge fixture only: real RPC serialization and signature validation.
export class Delivery extends WorkerEntrypoint {
 async send({ body, headers }) {
  const denied = await fetch('https://escape.example.invalid/').then(response => response.status);
  if (denied !== 502) throw new Error('RPC service escaped its isolated edge');
  const response = await receiver.fetch(new Request('https://receiver.example.invalid/deliveries', { method: 'POST', headers, body }), { secrets: { DELIVERY_SECRET: deliverySecret } });
  return { status: response.status, body: await response.json() };
 }
}
