import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import { readFile } from 'node:fs/promises';
import { rustls } from '../rustls.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DOH_ENDPOINT, EgressTransport, dohResolver } from '../index.ts';

/** The DNS-over-HTTPS response the fixed resolver would return, faked at the network edge only. */
function resolverEdge(answers: Record<string, () => Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const type = new URL(url).searchParams.get('type')!;
    return answers[type]!();
  };
  return { requests, fetch };
}
const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/dns-json' } });

test("DoH resolution queries both address families, rejects unusable answers and cancels bounded work", async t => {
  const step = namedSteps(t);
  await step('the DoH resolver asks the one fixed endpoint for A and AAAA and returns every address answer', async () => {
    const edge = resolverEdge({
      A: json({ Status: 0, Answer: [{ name: 'hooks.example.com', type: 5, data: 'edge.example.net.' }, { name: 'edge.example.net', type: 1, data: '93.184.216.34' }] }),
      AAAA: json({ Status: 0, Answer: [{ name: 'edge.example.net', type: 28, data: '2606:4700::6810:84E5' }] }),
    });
    assert.deepEqual(await dohResolver(edge.fetch)('hooks.example.com', new AbortController().signal), ['93.184.216.34', '2606:4700::6810:84e5']);
    assert.deepEqual(edge.requests.map(r => r.url).sort(), [`${DOH_ENDPOINT}?name=hooks.example.com&type=A`, `${DOH_ENDPOINT}?name=hooks.example.com&type=AAAA`]);
    for (const { init } of edge.requests) { assert.equal(init.redirect, 'manual'); assert.deepEqual(init.headers, { accept: 'application/dns-json' }); }
  });
  
  await step('any unusable resolver answer fails the lookup, and a non-public answer refuses the destination', async () => {
    const ok = json({ Status: 0, Answer: [] });
    const failing: [string, () => Response][] = [
      ['NXDOMAIN', json({ Status: 3 })], ['SERVFAIL', json({ Status: 2 })], ['HTTP 500', json({}, 500)],
      ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })],
      ['malformed JSON', () => new Response('{')], ['Answer not a list', json({ Status: 0, Answer: {} })],
      ['address not a string', json({ Status: 0, Answer: [{ type: 1, data: 7 }] })],
      ['oversized body', () => new Response(JSON.stringify({ Status: 0, pad: 'x'.repeat(70000) }))],
    ];
    for (const [name, answer] of failing) await assert.rejects(dohResolver(resolverEdge({ A: answer, AAAA: ok }).fetch)('hooks.example.com', new AbortController().signal), { message: 'egress_dns_failed' }, name);
    const tls = rustls(new WebAssembly.Module(await readFile(new URL('../tls/egress.wasm', import.meta.url))));
    for (const [query, privateRecord, publicV4] of [
      ['A', { type: 1, data: '10.0.0.7' }, '93.184.216.34'],
      ['A', { type: 28, data: 'fd00::1' }, '104.16.1.1'],
      ['AAAA', { type: 1, data: '127.0.0.1' }, '104.16.1.1'],
    ] as const) {
      let connects = 0, fetches = 0;
      const answers: Record<'A' | 'AAAA', { type: number; data: string }[]> = {
        A: [{ type: 1, data: publicV4 }],
        AAAA: [{ type: 28, data: '2606:4700::1' }],
      };
      answers[query].push(privateRecord);
      const transport = new EgressTransport({
        resolve: dohResolver(resolverEdge({ A: json({ Status: 0, Answer: answers.A }), AAAA: json({ Status: 0, Answer: answers.AAAA }) }).fetch),
        connect() { connects++; throw new Error('unreachable'); },
        async fetch() { fetches++; throw new Error('unreachable'); },
      }, { ownership: { zones: [], workersSuffix: 'fixture.workers.dev' }, tls });
      await assert.rejects(transport.send({ url: 'https://hooks.example.com/', headers: {}, body: '' }), { message: 'egress_dns_not_public' });
      assert.equal(connects, 0);
      assert.equal(fetches, 0);
    }
  });
  
  await step('send cancels both DNS requests on early failure, deadline and completed resolution', async () => {
    const tls = rustls(new WebAssembly.Module(await readFile(new URL('../tls/egress.wasm', import.meta.url))));
    for (const mode of ['failure', 'deadline', 'complete']) {
      const signals: AbortSignal[] = [];
      let finishLate: (() => void) | undefined, connects = 0;
      const resolve = dohResolver(async (url, init) => {
        const signal = init.signal!; signals.push(signal);
        const type = new URL(url).searchParams.get('type');
        if (mode === 'failure' && type === 'A') return Response.json({ Status: 2 });
        if (mode !== 'complete' && type === 'AAAA') {
          // A late edge response must never restart the failed/timed-out send.
          await new Promise<void>(done => { finishLate = done; });
        }
        return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
      });
      const transport = new EgressTransport({ resolve, connect() {
        connects++; assert.ok(signals.every(signal => signal.aborted));
        throw new Error('network edge deliberately unavailable');
      } }, { ownership: { zones: [], workersSuffix: 'fixture.workers.dev' }, tls, dnsTimeoutMs: 20 });
      await assert.rejects(transport.send({ url: 'https://hooks.example.com/', headers: {}, body: '' }), {
        message: mode === 'failure' ? 'egress_dns_failed' : mode === 'deadline' ? 'egress_dns_timeout' : 'egress_connection_failed',
      });
      assert.equal(signals.length, 2);
      assert.ok(signals.every(signal => signal.aborted), mode);
      finishLate?.();
      await delay(30);
      assert.equal(connects, mode === 'complete' ? 1 : 0);
    }
  });
})





