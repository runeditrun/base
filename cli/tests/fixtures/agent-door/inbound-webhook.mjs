import { deliveryRequest } from './receiver.mjs';
export default async function requests({ origin, outputs, secrets }) {
 const record = outputs.get('create');
 const signed = await deliveryRequest(record, crypto.randomUUID(), secrets.DELIVERY_SECRET);
 const wrong = await deliveryRequest(record, crypto.randomUUID(), 'wrong-per-installation-webhook-secret');
 return { valid: new Request(new URL('/deliveries', origin), signed), invalid: new Request(new URL('/deliveries', origin), wrong) };
}
