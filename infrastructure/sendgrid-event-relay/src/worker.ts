import { deliverSeed } from './seed.ts';
import { signRelayBody, verifySendGridWebhook } from './crypto.ts';

export interface Bindings {
  SENDGRID_WEBHOOK_PUBLIC_KEY: string;
  /** JSON map of fixed product markers to {url, secret}; store as a Worker secret. */
  RER_MAIL_RELAY_DESTINATIONS: string;
  /** Owner-preflighted versioned registry; optional and independent of products. */
  RER_MAIL_RELAY_SEEDS?: string;
}
interface Destination { url: string; secret: string }
function destinations(bindings: Bindings): Record<string, Destination> {
  if (!bindings.SENDGRID_WEBHOOK_PUBLIC_KEY) throw new Error('Missing provider key');
  const entries: unknown = JSON.parse(bindings.RER_MAIL_RELAY_DESTINATIONS);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 8) throw new Error('Invalid destinations');
  for (const [marker, entry] of Object.entries(entries)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(marker) || !entry || typeof entry.url !== 'string' || typeof entry.secret !== 'string' || entry.secret.length < 32) throw new Error('Invalid destination');
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid destination URL');
  }
  return entries as Record<string, Destination>;
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
}

export default {
  async fetch(request: Request, bindings: Bindings): Promise<Response> {
    let configured: Record<string, Destination>;
    try { configured = destinations(bindings); } catch { return new Response('Relay configuration is invalid.', { status: 503 }); }
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ status: 'ok', scope: 'configuration-only' });
    if (path !== '/events') return new Response('Not found.', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405, headers: { allow: 'POST' } });
    if (Number(request.headers.get('content-length')) > 1_048_576) return new Response('Payload too large.', { status: 413 });
    let rawBody: Uint8Array<ArrayBuffer> | null;
    try { rawBody = await readBody(request); } catch { return new Response('Invalid event body.', { status: 400 }); }
    if (rawBody === null) return new Response('Payload too large.', { status: 413 });
    if (!await verifySendGridWebhook({ publicKey: bindings.SENDGRID_WEBHOOK_PUBLIC_KEY, timestamp: request.headers.get('x-twilio-email-event-webhook-timestamp') ?? undefined, signature: request.headers.get('x-twilio-email-event-webhook-signature') ?? undefined, rawBody })) return new Response('Invalid provider signature.', { status: 401 });
    let events: unknown;
    try { events = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { return new Response('Invalid event body.', { status: 400 }); }
    if (!Array.isArray(events) || events.length > 10_000 || events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) return new Response('Invalid event body.', { status: 400 });
    const batches = new Map<string, object[]>();
    for (const event of events) {
      if (typeof event.rer_product !== 'string' || !Object.hasOwn(configured, event.rer_product)) continue;
      const batch = batches.get(event.rer_product) ?? [];
      batch.push(event); batches.set(event.rer_product, batch);
    }
    const seedDelivery = deliverSeed(events, rawBody, request.headers, bindings.RER_MAIL_RELAY_SEEDS);
    const results = await Promise.all([...batches].map(async ([marker, batch]) => {
      const destination = configured[marker]!;
      // Keep each receiver invocation within its D1 work budget. Products run
      // independently; chunks for one product remain ordered and sequential.
      for (let offset = 0; offset < batch.length; offset += 100) {
        const body = JSON.stringify(batch.slice(offset, offset + 100));
        const timestamp = String(Math.floor(Date.now() / 1000));
        try {
          const response = await fetch(destination.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
            headers: { 'content-type': 'application/json', 'user-agent': 'RunEditRun-Mail-Relay/1', 'x-rer-mail-timestamp': timestamp, 'x-rer-mail-signature': await signRelayBody(destination.secret, timestamp, body) }, body });
          await response.body?.cancel();
          if (!response.ok) {
            console.warn('Mail relay delivery failed', { product: marker, status: response.status });
            return false;
          }
        } catch {
          console.warn('Mail relay delivery failed', { product: marker, reason: 'transport' });
          return false;
        }
      }
      return true;
    }));
    await seedDelivery;
    // A failed destination makes SendGrid replay the signed batch. Successful
    // destinations must durably deduplicate sg_event_id before acknowledging.
    return new Response(null, { status: results.every(Boolean) ? 204 : 503 });
  },
};
