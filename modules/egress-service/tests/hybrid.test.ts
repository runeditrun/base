import { namedSteps, caseRows } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { certificates, egressModules, networkEdge, tlsReceiver, worker } from './fixture.ts';
import { EgressTransport } from '../transport.ts';
import { ownershipPolicy } from '../ownership.ts';
import { rustls } from '../rustls.ts';
import { RESPONSE_BODY_LIMIT, RESPONSE_HEAD_LIMIT, REQUEST_BODY_LIMIT } from '../policy.ts';

const { Miniflare } = await import(process.env.INTEGRATIONS_MINIFLARE_MODULE ?? 'miniflare');
const host = 'receiver.example.com', url = `https://${host}/events?keep=%2F`, raw = '93.184.216.34';
const wire = (overrides: Record<string, unknown> = {}) => ({ url, headers: { 'content-type': 'application/json', 'x-signature': 'exact' }, body: '{"text":"Café ☕"}', ...overrides });
const ownership = ownershipPolicy('["owned.example"]', 'fixture.workers.dev');

test("hybrid send preserves route selection, ownership exclusion and bounded response cleanup", async t => {
  await caseRows(t, [["hybrid send preserves route selection, ownership exclusion and bounded response cleanup", async t => {
  const step = namedSteps(t);
  await step("hybrid egress admits only validated non-owned destinations and sends once through the selected route", async t => {
    const step = namedSteps(t);
    await step('hybrid routing and account exclusion through real Worker service bindings', async t => {
      const certs = await certificates(), edge = networkEdge(), modules = await egressModules(certs.ca);
      const receiver = await tlsReceiver(certs.receiver);
      edge.state.routes.set(raw, receiver.port);
      const fetched: { url: string; method: string; headers: Headers; body: string }[] = [];
      const outbound = { outboundService: { type: 'fetcher', handler: async (request: Request) => {
        fetched.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() });
        return new Response('moved', { status: 302, headers: { location: 'https://169.254.169.254/private' } });
      } } };
      const missing = worker('egress-missing', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler } }, outbound);
      delete (missing.config.env as Record<string, unknown>).EGRESS_OWNED_ZONES;
      const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [
        worker('caller', modules.caller, { EGRESS: { type: 'worker', worker: 'egress' } }),
        worker('caller-narrow', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', props: { allowedHosts: ['other.example'] } } }),
        worker('caller-owned', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', props: { allowedHosts: ['owned.example', '*.owned.example', 'fixture.workers.dev', '*.fixture.workers.dev'] } } }),
        worker('caller-inject', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', props: { allowedHosts: [host], EGRESS_OWNED_ZONES: [] } } }),
        worker('caller-grant', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', exportName: 'EgressRestricted', props: { allowedHosts: [host] } } }),
        worker('caller-missing', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-missing' } }),
        worker('caller-invalid', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-invalid' } }),
        worker('egress', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler }, EGRESS_OWNED_ZONES: { type: 'text', value: '["owned.example"]' }, EGRESS_GRANTS: { type: 'text', value: '[{"entrypoint":"EgressRestricted","allowedHosts":["other.example"]}]' } }, outbound),
        missing,
        worker('egress-invalid', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler }, EGRESS_WORKERS_SUFFIX: { type: 'text', value: '*.workers.dev' } }, outbound),
      ] });
      const send = async (request = wire(), name = 'caller') => {
        const response = await (await runtime.getWorker(name)).fetch('https://caller/', { method: 'POST', body: JSON.stringify({ wires: [request] }) });
        return (await response.json()).results[0];
      };
      try {
        await step('all Cloudflare IPv4 and compressed IPv6 ranges use exactly one original-URL manual POST', async () => {
          // Interior and boundary addresses exercise numeric prefix membership via the actual routing door.
          const cf = ['173.245.48.1', '103.21.244.1', '103.22.200.1', '103.31.4.1', '141.101.64.1', '108.162.192.1',
            '190.93.240.1', '188.114.96.1', '197.234.240.1', '198.41.128.1', '162.159.255.255', '104.23.255.255',
            '104.27.255.255', '172.71.255.255', '131.0.72.1', '2400:cb00::1', '2606:4700::1', '2803:f800::1',
            '2405:b500::1', '2405:8100::1', '2A06:98C7:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', '2c0f:f248::1'];
          for (const address of cf) {
            edge.state.answers.set(host, [[address]]);
            const before = fetched.length;
            const result = await send();
            assert.equal(result.response.status, 302, address);
            assert.equal(result.response.headers.location, 'https://169.254.169.254/private');
            assert.equal(fetched.length, before + 1, 'manual redirect does not send another request');
            const seen = fetched.at(-1)!;
            assert.equal(seen.url, url); assert.equal(seen.method, 'POST'); assert.equal(seen.body, wire().body);
            assert.equal(seen.headers.get('x-signature'), 'exact');
          }
          assert.deepEqual(edge.state.connects, []);
          assert.equal(receiver.requests.length, 0);
        });
        await step('mixed answers pin first non-Cloudflare address, preserving real rustls hostname validation and no retry', async () => {
          const before = fetched.length;
          for (const answers of [['104.16.1.1', raw, '8.8.8.8'], [raw, '2606:4700::1'], ['2606:4700::1', raw]]) {
            edge.state.answers.set(host, [answers]);
            assert.equal((await send()).response.status, 204);
            assert.equal(receiver.requests.at(-1)!.servername, host);
            assert.equal(edge.state.connects.at(-1), raw);
          }
          // Just outside variable prefix ranges must use raw sockets, not fetch.
          for (const outside of ['104.28.0.0', '172.72.0.0', '162.157.255.255', '2a06:98c8::1', '2606:4701::1']) {
            edge.state.answers.set(host, [[outside, '104.16.1.1']]);
            assert.equal((await send()).error, 'egress_connection_failed');
            assert.equal(edge.state.connects.at(-1), outside.includes(':') ? `[${outside}]` : outside);
          }
          assert.equal(fetched.length, before);
        });
        await step('whole-answer validation and all request checks precede either send route', async () => {
          const before = [fetched.length, edge.state.connects.length];
          for (const answers of [[], ['104.16.1.1', '10.0.0.1'], ['2606:4700::1', 'fd00::1'], ['104.16.1.1', 'oops'], ['[2606:4700::1]']]) {
            edge.state.answers.set(host, [answers]);
            assert.equal((await send()).error, 'egress_dns_not_public');
          }
          edge.state.answers.set(host, [['104.16.1.1']]);
          for (const [input, code] of [
            [wire({ headers: { host: 'other.example' } }), 'egress_header_forbidden'],
            [wire({ headers: { 'x-inject': 'bad\r\nheader' } }), 'egress_header_invalid'],
            [wire({ body: 'x'.repeat(REQUEST_BODY_LIMIT + 1) }), 'egress_request_too_large'],
            [wire({ url: 'http://receiver.example.com/' }), 'egress_destination_refused'],
          ] as const) assert.equal((await send(input)).error, code);
          assert.deepEqual([fetched.length, edge.state.connects.length], before);
        });
        await step('ownership apex and descendants block both routes; caller data, grants and props cannot widen', async () => {
          const before = [fetched.length, edge.state.connects.length, edge.state.resolutions.length];
          for (const address of [raw, '104.16.1.1']) for (const name of ['owned.example', 'sub.owned.example', 'fixture.workers.dev', 'service.fixture.workers.dev']) {
            edge.state.answers.set(name, [[address]]);
            assert.equal((await send(wire({ url: `https://${name}/`, EGRESS_OWNED_ZONES: '[]', ownership: { zones: [] } }), 'caller-owned')).error, 'egress_destination_not_allowed');
          }
          edge.state.answers.set(host, [['104.16.1.1']]);
          for (const caller of ['caller-narrow', 'caller-grant']) assert.equal((await send(wire(), caller)).error, 'egress_destination_not_allowed');
          for (const caller of ['caller-inject', 'caller-missing', 'caller-invalid']) assert.equal((await send(wire(), caller)).error, 'egress_configuration_invalid');
          assert.deepEqual([fetched.length, edge.state.connects.length, edge.state.resolutions.length], before);
          for (const name of ['notowned.example', 'owned.example.other', 'other.workers.dev', 'notfixture.workers.dev']) {
            edge.state.answers.set(name, [['104.16.1.1']]);
            assert.equal((await send(wire({ url: `https://${name}/` }))).response.status, 302);
          }
        });
      } finally { await runtime.dispose(); await Promise.all([receiver.close(), modules.cleanup(), certs.cleanup()]); }
    });
  })

  await step('fetch send enforces head/body caps, cancels on failure, and exposes only fixed errors', async () => {
    for (const [response, code] of [
      [() => new Response('x', { headers: { huge: 'x'.repeat(RESPONSE_HEAD_LIMIT) } }), 'egress_response_head_too_large'],
      [() => new Response('x'.repeat(RESPONSE_BODY_LIMIT + 1)), 'egress_response_too_large'],
      [() => new Response(new Uint8Array(RESPONSE_BODY_LIMIT).fill(255)), 'egress_response_too_large'],
      [() => new Response('a', { headers: { 'content-length': '4' } }), 'egress_response_incomplete'],
      [() => new Response('a', { headers: { 'content-length': 'invalid' } }), 'egress_response_malformed'],
    ] as const) {
      const transport = fetchTransport(async () => response());
      await assert.rejects(transport.send(wire()), { message: code });
    }
    let canceled = 0, calls = 0;
    const transport = fetchTransport(async (_url, init) => {
      calls++; assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(RESPONSE_BODY_LIMIT + 1)); }, cancel() { canceled++; } }));
    });
    await assert.rejects(transport.send(wire()), { message: 'egress_response_too_large' });
    assert.equal(canceled, 1); assert.equal(calls, 1);
    await assert.rejects(fetchTransport(async () => { throw new Error('secret URL provider detail'); }).send(wire()), { message: 'egress_connection_failed' });
  });

  await step('fetch deadline cancels stalled and late response bodies without awaiting peer cancellation', async () => {
    for (const late of [false, true]) {
      let canceled = 0, calls = 0;
      let signal: AbortSignal | undefined, release: (() => void) | undefined;
      const transport = fetchTransport(async (_url, init) => {
        calls++; signal = init.signal as AbortSignal;
        if (late) await new Promise<void>(resolve => { release = resolve; });
        return new Response(new ReadableStream({ cancel() { canceled++; return new Promise(() => {}); } }));
      }, 20);
      await assert.rejects(transport.send(wire()), { message: 'egress_request_timeout' });
      assert.equal(signal?.aborted, true);
      release?.(); await delay(20);
      assert.equal(canceled, 1); assert.equal(calls, 1);
    }
  });

  }]]);
})



// Fetch is the only fake here: the public transport send door runs real validation, routing,
// bounds and deadlines. The raw path uses the production rustls factory and must stay unused.
const tls = rustls(new WebAssembly.Module(await readFile(new URL('../tls/egress.wasm', import.meta.url))));
function fetchTransport(fetch: (url: string, init: RequestInit) => Promise<Response>, requestTimeoutMs = 100) {
  return new EgressTransport({ resolve: async () => ['104.16.1.1', '2606:4700::1'],
    connect() { assert.fail('no raw connection or fallback'); }, fetch,
  }, { tls, ownership, requestTimeoutMs });
}
