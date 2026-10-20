import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import worker from './src/worker.ts';
import { verifySendGridWebhook, verifyRelayRequest } from './src/crypto.ts';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const bindings = { SENDGRID_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), RER_MAIL_RELAY_DESTINATIONS: JSON.stringify({ lamp: { url: 'https://lamp.example/events', secret: 'l'.repeat(32) }, orbit: { url: 'https://orbit.example/events', secret: 'o'.repeat(32) } }) };
function request(events: object[], override?: { body?: string; timestamp?: string }) {
  const body = JSON.stringify(events), timestamp = override?.timestamp ?? String(Math.floor(Date.now() / 1000));
  return new Request('https://relay.example/events', { method: 'POST', body: override?.body ?? body, headers: { 'x-twilio-email-event-webhook-timestamp': timestamp, 'x-twilio-email-event-webhook-signature': sign('sha256', Buffer.from(timestamp + body), privateKey).toString('base64') } });
}

test('mixed signed batch partitions products, ignores unknown markers and signs each exact forwarded body', async t => {
  const forwarded: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = String(init.body), headers = new Headers(init.headers), product = url.includes('lamp') ? 'lamp' : 'orbit';
    forwarded.push(product);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    assert.deepEqual(JSON.parse(body).map((e: { rer_product: string }) => e.rer_product), [product]);
    assert.equal(await verifyRelayRequest({ secret: product === 'lamp' ? 'l'.repeat(32) : 'o'.repeat(32), timestamp: headers.get('x-rer-mail-timestamp')!, signature: headers.get('x-rer-mail-signature')!, rawBody: body }), true);
    assert.equal(await verifyRelayRequest({ secret: product === 'lamp' ? 'o'.repeat(32) : 'l'.repeat(32), timestamp: headers.get('x-rer-mail-timestamp')!, signature: headers.get('x-rer-mail-signature')!, rawBody: body }), false);
    return new Response(null, { status: 204 });
  });
  const result = await worker.fetch(request([{ rer_product: 'lamp', email: 'lamp-only@example.test' }, { rer_product: 'orbit', email: 'orbit-only@example.test' }, { rer_product: 'unrelated', email: 'never-forward@example.test' }]), bindings);
  assert.equal(result.status, 204); assert.deepEqual(forwarded.sort(), ['lamp', 'orbit']);
});

test('invalid and stale signatures cause no forward; unknown-only payload is acknowledged silently', async t => {
  const spy = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not forward'); });
  assert.equal((await worker.fetch(request([{ rer_product: 'lamp' }], { body: '[]' }), bindings)).status, 401);
  assert.equal((await worker.fetch(request([{ rer_product: 'lamp' }], { timestamp: '1' }), bindings)).status, 401);
  assert.equal((await worker.fetch(request([{ rer_product: 'unrelated', private: 'unknown account' }]), bindings)).status, 204);
  assert.equal(spy.mock.callCount(), 0);
});

test('one failed destination requests provider retry while both destinations are attempted; error details stay private', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(url); return url.includes('orbit') ? new Response('private details', { status: 500 }) : new Response(null, { status: 204 }); });
  const result = await worker.fetch(request([{ rer_product: 'lamp' }, { rer_product: 'orbit' }]), bindings);
  assert.equal(result.status, 503); assert.equal(await result.text(), ''); assert.equal(calls.length, 2);
});

test('receiver rejects mutated body, stale timestamp and malformed signature', async () => {
  assert.equal(await verifyRelayRequest({ secret: 'l'.repeat(32), timestamp: '1', signature: 'v1=' + '0'.repeat(64), rawBody: '[]' }), false);
  assert.equal(await verifyRelayRequest({ secret: 'l'.repeat(32), timestamp: String(Math.floor(Date.now()/1000)), signature: 'invalid', rawBody: '[]' }), false);
});

test('redirects are returned without forwarding receiver credentials to another URL', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests++;
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://another.example/' } });
  });
  assert.equal((await worker.fetch(request([{ rer_product: 'orbit' }]), bindings)).status, 503);
  assert.equal(requests, 1);
});

test('large mixed batches preserve every event once in bounded independently signed chunks', async t => {
  const received = new Map<string, number[]>(), sizes = new Map<string, number[]>();
  const active = new Set<string>();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const product = url.includes('lamp') ? 'lamp' : 'orbit';
    assert.equal(active.has(product), false, 'one request per product at a time');
    active.add(product);
    const body = String(init.body), headers = new Headers(init.headers);
    const events = JSON.parse(body) as {rer_product: string; sequence: number}[];
    assert.ok(events.length <= 100 && events.length > 0);
    assert.ok(events.every(event => event.rer_product === product));
    assert.equal(await verifyRelayRequest({secret: (product === 'lamp' ? 'l' : 'o').repeat(32), timestamp: headers.get('x-rer-mail-timestamp')!, signature: headers.get('x-rer-mail-signature')!, rawBody: body}), true);
    received.set(product, [...(received.get(product) ?? []), ...events.map(event => event.sequence)]);
    sizes.set(product, [...(sizes.get(product) ?? []), events.length]);
    active.delete(product);
    return new Response(null, {status: 204});
  });
  const events = Array.from({length: 205}, (_,sequence) => [{rer_product:'lamp',sequence}, ...(sequence < 101 ? [{rer_product:'orbit',sequence}] : []), {rer_product:'unrelated',sequence}]).flat();
  assert.equal((await worker.fetch(request(events), bindings)).status, 204);
  assert.deepEqual(sizes.get('lamp'), [100,100,5]);
  assert.deepEqual(sizes.get('orbit'), [100,1]);
  assert.deepEqual(received.get('lamp'), Array.from({length:205},(_,i)=>i));
  assert.deepEqual(received.get('orbit'), Array.from({length:101},(_,i)=>i));
});

test('a failed later chunk requests replay; replay includes prior chunks for receiver deduplication', async t => {
  const calls: number[][] = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const ids = JSON.parse(String(init.body)).map((event: {sequence:number})=>event.sequence);
    calls.push(ids);
    if(fail && ids[0]===100)return new Response('private receiver failure',{status:503});
    return new Response(null,{status:204});
  });
  const events = Array.from({length:205},(_,sequence)=>({rer_product:'lamp',sequence}));
  const first = await worker.fetch(request(events),bindings);
  assert.equal(first.status,503);assert.equal(await first.text(),'');
  assert.deepEqual(calls.map(ids=>ids[0]),[0,100]);
  fail=false;
  assert.equal((await worker.fetch(request(events),bindings)).status,204);
  assert.deepEqual(calls.slice(2).flat(),Array.from({length:205},(_,i)=>i));
});


test('registered seed receives only a whole signed scope, byte exact, independently of legacy delivery', async t => {
  const seed = { rer_seed: 'spool', rer_test_installation: 'test-installation' };
  const target = { seed: 'spool', installationId: 'test-installation', url: 'https://mail-relay-scratch.runeditrun.com/events', expiresAt: Date.now() + 60_000 };
  const environment = (entry = target) => ({ ...bindings, RER_MAIL_RELAY_SEEDS: JSON.stringify({ version: 1, targets: [entry] }) });
  const counters: Record<string, number>[] = [];
  t.mock.method(console, 'info', (message: string, counts: Record<string, number>) => { if (message === 'Mail seed relay counts') counters.push(counts); });
  t.mock.method(console, 'warn', () => {});
  let targetStatus = 204, legacyStatus = 204, dnsAddress = '104.16.1.1', dnsFailure = false;
  let seedCalls = 0, legacyCalls = 0;
  let expectedBody = new Uint8Array(), expectedHeaders = new Headers();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('https://cloudflare-dns.com/')) {
      if (dnsFailure) throw new Error('network edge unavailable');
      return Response.json({ Status: 0, Answer: [{ type: 1, data: dnsAddress }] });
    }
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    const headers = new Headers(init.headers);
    assert.ok(headers.get('user-agent'));
    if (url === target.url) {
      seedCalls++;
      assert.deepEqual(new Uint8Array(init.body as Uint8Array), expectedBody);
      for (const header of ['x-twilio-email-event-webhook-signature', 'x-twilio-email-event-webhook-timestamp']) {
        assert.equal(headers.get(header), expectedHeaders.get(header));
      }
      assert.equal(headers.has('x-rer-mail-signature'), false);
      assert.equal(await verifySendGridWebhook({ publicKey: bindings.SENDGRID_WEBHOOK_PUBLIC_KEY,
        timestamp: headers.get('x-twilio-email-event-webhook-timestamp')!, signature: headers.get('x-twilio-email-event-webhook-signature')!, rawBody: expectedBody }), true);
      return new Response(null, { status: targetStatus, headers: targetStatus === 302 ? { location: 'http://127.0.0.1/private' } : {} });
    }
    legacyCalls++;
    assert.equal(url, 'https://lamp.example/events');
    assert.equal(await verifyRelayRequest({ secret: 'l'.repeat(32), timestamp: headers.get('x-rer-mail-timestamp')!,
      signature: headers.get('x-rer-mail-signature')!, rawBody: String(init.body) }), true);
    return new Response(null, { status: legacyStatus });
  });
  async function send(events: object[], env = environment()) {
    const body = ' [ \n' + events.map(event => JSON.stringify(event)).join(', \n') + '\n ] ';
    expectedBody = new TextEncoder().encode(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    expectedHeaders = new Headers({ 'x-twilio-email-event-webhook-timestamp': timestamp,
      'x-twilio-email-event-webhook-signature': sign('sha256', Buffer.from(timestamp + body), privateKey).toString('base64') });
    return worker.fetch(new Request('https://relay.example/events', { method: 'POST', body, headers: expectedHeaders }), env);
  }
  const event = { ...seed, rer_product: 'lamp', event: 'delivered', label: 'é 🚀' };
  assert.equal((await send([event, event])).status, 204);
  assert.equal(seedCalls, 1); assert.equal(legacyCalls, 1);
  assert.equal(counters.at(-1)!.delivered, 1);
  // One transient retry, with the original bytes and provider headers each time.
  targetStatus = 503;
  assert.equal((await send([event])).status, 204);
  assert.equal(seedCalls, 3); assert.equal(counters.at(-1)!.targetFailures, 1);
  targetStatus = 302;
  assert.equal((await send([event])).status, 204);
  assert.equal(seedCalls, 4);
  targetStatus = 204; legacyStatus = 503;
  assert.equal((await send([event])).status, 503);
  assert.equal(seedCalls, 5); // legacy failure never prevents seed delivery
  legacyStatus = 204;
  for (const events of [[{ ...event, rer_seed: 'unknown' }], [event, { rer_product: 'lamp' }],
    [event, { ...event, rer_test_installation: 'another' }], [event, { ...event, rer_seed: 'another' }]]) {
    assert.equal((await send(events)).status, 204);
    assert.equal(seedCalls, 5);
  }
  assert.equal(counters.filter(counts => counts.mixedBatches).length, 3);
  assert.equal((await send([event], environment({ ...target, expiresAt: Date.now() - 1 }))).status, 204);
  assert.equal(counters.at(-1)!.expired, 1);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    dnsAddress = address;
    assert.equal((await send([event])).status, 204);
    assert.equal(counters.at(-1)!.configurationFailures, 1);
  }
  dnsFailure = true;
  assert.equal((await send([event])).status, 204);
  assert.equal(counters.at(-1)!.configurationFailures, 1);
  for (const url of ['http://mail-relay-scratch.runeditrun.com/events', 'https://fixture-user:fixture-password@mail-relay-scratch.runeditrun.com/events',
    'https://127.0.0.1/events', 'https://[::1]/events', 'https://localhost/events', 'https://arbitrary.example/events']) {
    assert.equal((await send([event], environment({ ...target, url }))).status, 204);
    assert.equal(counters.at(-1)!.configurationFailures, 1);
  }
  assert.equal(seedCalls, 5);
  // An invalid provider signature cannot reach either route.
  const before = legacyCalls;
  assert.equal((await worker.fetch(request([event], { body: '[]' }), environment())).status, 401);
  assert.equal(legacyCalls, before); assert.equal(seedCalls, 5);
});
