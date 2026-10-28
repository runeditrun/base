import { namedSteps, caseRows } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import net from 'node:net';
import assert from 'node:assert/strict';
import { certificates, egressModules, networkEdge, outboundRecorder, tlsReceiver, worker, type Recorded } from './fixture.ts';
import { deniedAddresses, publicAddresses, literalUrl } from '../../integrations/tests/core/public-address-cases.ts';
import { createWebhookProtocol, verifyWebhook } from '../../integrations/index.ts';
import { REQUEST_BODY_LIMIT, RESPONSE_BODY_LIMIT, RESPONSE_HEAD_LIMIT } from '../policy.ts';

const certs = await certificates();

const { Miniflare } = await import(process.env.INTEGRATIONS_MINIFLARE_MODULE ?? 'miniflare');

const host = 'receiver.example.com', pinned = '93.184.216.34', url = `https://${host}/events`;
// Named examples the brief calls out, beside the shared endpoint table.
const namedDenied = ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '100.64.1.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:a00:1'];
const denied = [...new Set([...namedDenied, ...deniedAddresses])];

test("egress service binding enforces signed delivery, endpoint policy, TLS and resource bounds", async t => {
  await caseRows(t, [["egress service binding enforces signed delivery, endpoint policy, TLS and resource bounds", async t => {
  const step = namedSteps(t);
  await step('enforcing egress service in workerd through a service binding', async t => {
    const edge = networkEdge(), outbound = outboundRecorder(), deployedOutbound = outboundRecorder(), strangerOutbound = outboundRecorder();
    const receiver = await tlsReceiver(certs.receiver), wrongHost = await tlsReceiver(certs.otherHost), untrusted = await tlsReceiver(certs.untrusted), expired = await tlsReceiver(certs.expired);
    const modules = await egressModules(certs.ca);
    edge.state.answers.set(host, [[pinned]]);
    edge.state.routes.set(pinned, receiver.port);
    const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [
      worker('caller', modules.caller, { EGRESS: { type: 'worker', worker: 'egress' } }),
      worker('caller-narrow', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', props: { allowedHosts: [host] } } }),
      worker('caller-grant-props', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', exportName: 'EgressRestricted', props: { allowedHosts: ['other.example.com'] } } }),
      worker('caller-grant-service', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-listed', exportName: 'EgressRestricted' } }),
      worker('caller-grant', modules.caller, { EGRESS: { type: 'worker', worker: 'egress', exportName: 'EgressRestricted' } }),
      worker('caller-missing-grant', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-missing-grant', exportName: 'EgressRestricted' } }),
      worker('caller-duplicate-grant', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-duplicate-grant', exportName: 'EgressRestricted' } }),
      worker('caller-listed', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-listed' } }),
      worker('caller-deployable', modules.caller, { EGRESS: { type: 'worker', worker: 'egress-deployable' } }),
      worker('stranger', modules.caller, {}, strangerOutbound.service),
      worker('egress', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler }, EGRESS_GRANTS: { type: 'text', value: JSON.stringify([{entrypoint:'EgressRestricted',allowedHosts:[host]}]) } }, outbound.service),
      worker('egress-listed', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler }, EGRESS_ALLOWED_HOSTS: { type: 'text', value: '*.allowed.example' }, EGRESS_GRANTS: { type:'text',value:JSON.stringify([{entrypoint:'EgressRestricted',allowedHosts:[host]}]) } }, outbound.service),
      worker('egress-missing-grant', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler } }, outbound.service),
      worker('egress-duplicate-grant', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler }, EGRESS_GRANTS: { type: 'text', value: JSON.stringify([{entrypoint:'EgressRestricted',allowedHosts:[host]},{entrypoint:'EgressRestricted',allowedHosts:null}]) } }, outbound.service),
      worker('egress-deployable', modules.deployable, { EGRESS_GRANTS: { type: 'text', value: JSON.stringify([{entrypoint:'EgressService',allowedHosts:null}]) } }, deployedOutbound.service),
    ] });
    const call = async (name: string, body: unknown) => (await (await runtime.getWorker(name)).fetch('http://caller/', { method: 'POST', body: JSON.stringify(body) })).json();
    const send = async (wires: unknown[], name = 'caller') => (await call(name, { wires })).results as { response?: { status: number; headers: Record<string, string>; body: string }; error?: string }[];
    const one = async (wire: unknown, name = 'caller') => (await send([wire], name))[0]!;
    const wire = (overrides: Record<string, unknown> = {}) => ({ url, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', ...overrides });
    /** Runs rows and proves none of them opened a socket. */
    const refusedBeforeConnect = async (rows: [unknown, string][], name = 'caller') => {
      const connects = edge.state.connects.length, requests = receiver.requests.length;
      const results = await send(rows.map(([w]) => w), name);
      results.forEach((result, i) => assert.equal(result.error, rows[i]![1], JSON.stringify(rows[i]![0]).slice(0, 120)));
      assert.equal(edge.state.connects.length, connects, 'socket fixture records zero connects');
      assert.equal(receiver.requests.length, requests);
    };
    const reply = (fn: (request: Recorded) => string | Buffer | { truncate: string }) => { receiver.reply = fn; };
    try {
      await step('delivers a signed webhook to an allowed public name: exact bytes once, pinned address, verified HMAC', async () => {
        const key = new Uint8Array(32).fill(7);
        const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
        const envelope = { id: 'evt-1', tenant: 'installation', destinationId: 'dest-1', event: 'issue.created', protocol: 'webhook', body: '{"text":"Café ☕"}' };
        const signed = await protocol.prepare(envelope, Date.now());
        reply(() => 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}');
        const before = { resolutions: edge.state.resolutions.length, connects: edge.state.connects.length };
        const result = await one(signed);
        assert.deepEqual(result.response, { status: 200, headers: { 'content-type': 'application/json', 'content-length': '11', connection: 'close' }, body: '{"ok":true}' });
        assert.deepEqual(edge.state.resolutions.slice(before.resolutions), [host]);
        assert.deepEqual(edge.state.connects.slice(before.connects), [pinned]);
        assert.equal(receiver.requests.length, 1);
        const seen = receiver.requests[0]!;
        assert.equal(seen.servername, host, 'TLS names the original host (rustls SNI)');
        assert.equal(seen.head.split('\r\n')[0], 'POST /events HTTP/1.1');
        assert.equal(seen.headers.host, host);
        for (const [name, value] of Object.entries(signed.headers)) assert.equal(seen.headers[name.toLowerCase()], value, name);
        assert.ok(seen.body.equals(Buffer.from(signed.body, 'utf8')), 'exact body bytes');
        const verified = await verifyWebhook({ body: new Uint8Array(seen.body), headers: seen.headers, key, tenant: 'installation', destinationId: 'dest-1' });
        assert.equal(verified.envelope.id, 'evt-1');
      });

      await step('refuses non-public literals, non-HTTPS, credentials, ports and local names before any connection', async () => {
        const literal = denied.map(address => [wire({ url: literalUrl(address) }), 'egress_destination_refused'] as [unknown, string]);
        await refusedBeforeConnect([...literal,
          ...['http://receiver.example.com/', 'https://user:pass@receiver.example.com/', 'https://receiver.example.com:8443/', 'https://localhost/',
            'https://hooks.localhost/', 'https://printer.local/', 'https://db.internal/', 'https://x.test/', 'https://receiver.example.com./', 'ftp://receiver.example.com/', 'not a url']
            .map(u => [wire({ url: u }), 'egress_destination_refused'] as [unknown, string])]);
      });

      await step('refuses a name whose answers include any non-public address, alone or mixed, before any connection', async () => {
        const rows: [unknown, string][] = [];
        denied.forEach((address, i) => {
          for (const [n, answers] of [[0, [address]], [1, ['8.8.8.8', address]], [2, [address, '2606:4700:4700::1111']]] as const) {
            const name = `n${i}-${n}.example.com`;
            edge.state.answers.set(name, [[...answers]]);
            rows.push([wire({ url: `https://${name}/` }), 'egress_dns_not_public']);
          }
        });
        edge.state.answers.set('empty.example.com', [[]]);
        edge.state.answers.set('malformed.example.com', [['8.8.8.256']]);
        rows.push([wire({ url: 'https://empty.example.com/' }), 'egress_dns_not_public'], [wire({ url: 'https://malformed.example.com/' }), 'egress_dns_not_public'],
          [wire({ url: 'https://unknown.example.com/' }), 'egress_dns_failed']);
        await refusedBeforeConnect(rows);
      });

      await step('public answers connect only to the first validated non-Cloudflare address', async () => {
        const before = edge.state.connects.length;
        const names = publicAddresses.map((address, i) => { const name = `p${i}.example.com`; edge.state.answers.set(name, [[address, '8.8.4.4']]); return name; });
        const results = await send(names.map(name => wire({ url: `https://${name}/` })));
        results.forEach(result => assert.equal(result.error, 'egress_connection_failed', 'the socket fixture has no route for these'));
        // These public-address fixture cases are Cloudflare; route selection is separately
        // exercised across every bundled range in hybrid.test.ts.
        const cloudflareCases = new Set(['2606:4700:4700::1111', '2606:4700::5efd:ffff:ffff', '2606:4700::201:5efe:1:1']);
        assert.deepEqual(edge.state.connects.slice(before), publicAddresses.map(address => cloudflareCases.has(address) ? '8.8.4.4' : address.includes(':') ? `[${address}]` : address));
      });

      await step('a DNS answer that changes between check and connect: one resolution, socket to the first validated address', async () => {
        edge.state.answers.set('rebind.example.com', [[pinned], ['127.0.0.1']]);
        edge.state.routes.set(pinned, wrongHost.port); // any socket would do; the address is what is checked
        const before = { resolutions: edge.state.resolutions.length, connects: edge.state.connects.length };
        await one(wire({ url: 'https://rebind.example.com/' }));
        edge.state.routes.set(pinned, receiver.port);
        assert.deepEqual(edge.state.resolutions.slice(before.resolutions), ['rebind.example.com']);
        assert.deepEqual(edge.state.connects.slice(before.connects), [pinned]);
      });

      await step('a 302 to a refused address is returned as the response; nothing follows it', async () => {
        reply(() => 'HTTP/1.1 302 Found\r\nLocation: https://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\n\r\n');
        const before = edge.state.connects.length, requests = receiver.requests.length;
        const result = await one(wire());
        assert.equal(result.response?.status, 302);
        assert.equal(result.response?.headers.location, 'https://169.254.169.254/latest/meta-data');
        assert.equal(edge.state.connects.length, before + 1);
        assert.equal(receiver.requests.length, requests + 1);
      });

      await step('a certificate for another hostname from an untrusted authority or expired is refused', async () => {
        try {
          for (const peer of [wrongHost, untrusted, expired]) {
            edge.state.routes.set(pinned, peer.port);
            const connections = peer.connections;
            assert.equal((await one(wire())).error, 'egress_connection_failed');
            assert.equal(peer.connections, connections + 1, 'the pinned socket reached this peer');
            assert.equal(peer.requests.length, 0, 'TLS verification refused it before any request byte');
          }
        } finally { edge.state.routes.set(pinned, receiver.port); }
      });

      await step('limits and malformed responses are refused with fixed codes', async () => {
        await refusedBeforeConnect([
          [wire({ body: 'x'.repeat(REQUEST_BODY_LIMIT + 1) }), 'egress_request_too_large'],
          ...['Host', 'connection', 'Transfer-Encoding', 'content-length', 'Proxy-Authorization'].map(name => [wire({ headers: { [name]: 'x' } }), 'egress_header_forbidden'] as [unknown, string]),
          [wire({ headers: { 'x-a': 'one\r\nx-injected: two' } }), 'egress_header_invalid'],
          [wire({ headers: { 'bad name': 'x' } }), 'egress_header_invalid'],
          [{ url, headers: [], body: '' }, 'egress_request_invalid'],
        ]);
        assert.equal((await one(wire({ body: 'x'.repeat(REQUEST_BODY_LIMIT) }))).response?.status, 302, 'a body at the limit is sent');
        const big = 'a'.repeat(RESPONSE_BODY_LIMIT + 1);
        const cases: [string | { truncate: string }, string][] = [
          [`HTTP/1.1 200 OK\r\nContent-Length: ${big.length}\r\n\r\n${big}`, 'egress_response_too_large'],
          [`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`, 'egress_response_too_large'],
          [`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${big}`, 'egress_response_too_large'],
          [`HTTP/1.1 200 OK\r\nX-Big: ${'h'.repeat(RESPONSE_HEAD_LIMIT)}\r\n\r\n`, 'egress_response_head_too_large'],
          ['HTTP/1.1 OK\r\n\r\n', 'egress_response_malformed'],
          ['SMTP ready\r\n\r\n', 'egress_response_malformed'],
          ['HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', 'egress_response_malformed'],
          ['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort', 'egress_response_incomplete'],
          [{ truncate: 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npartial' }, 'egress_connection_failed'],
          ['stall', 'egress_request_timeout'],
        ];
        for (const [response, code] of cases) { reply(() => response); assert.equal((await one(wire())).error, code, code); }
        reply(() => `HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nX-Trailer: t\r\n\r\n`);
        assert.deepEqual((await one(wire())).response, { status: 201, headers: { 'transfer-encoding': 'chunked' }, body: 'abcde' });
        edge.state.answers.set('slow.example.com', [[pinned]]); edge.state.dnsDelayMs = 2500;
        assert.equal((await one(wire({ url: 'https://slow.example.com/' }))).error, 'egress_dns_timeout');
        edge.state.dnsDelayMs = 0;
      });

      await step('callers: the binding is the capability, props only narrow, the public door is 404', async () => {
        assert.deepEqual(await call('stranger', { wires: [wire()] }), { binding: false });
        assert.deepEqual(await call('stranger', { url: 'https://egress.example.workers.dev/' }), { status: 502 });
        assert.deepEqual(strangerOutbound.urls, ['https://egress.example.workers.dev/'], 'without a binding the only path is ordinary internet fetch');
        for (const name of ['egress', 'egress-deployable']) for (const method of ['GET', 'POST']) {
          const response = await (await runtime.getWorker(name)).fetch('https://egress.example/send', { method, ...(method === 'POST' ? { body: JSON.stringify(wire()) } : {}) });
          assert.equal(response.status, 404); await response.arrayBuffer();
        }
        for (const probe of ['exchange', 'resolveOnce', 'ports']) assert.notEqual((await call('caller', { probe })).probe, 'reached', probe);
        edge.state.answers.set('second.example.com', [[pinned]]);
        reply(() => 'HTTP/1.1 204 No Content\r\n\r\n');
        assert.equal((await one(wire(), 'caller-narrow')).response?.status, 204);
        assert.equal((await one(wire(), 'caller-grant')).response?.status, 204);
        await refusedBeforeConnect([[wire({url:'https://second.example.com/', allowedHosts:[host,'second.example.com'], grant:'EgressService'}), 'egress_destination_not_allowed']], 'caller-grant');
        for (const caller of ['caller-grant-props','caller-grant-service']) await refusedBeforeConnect([[wire(), 'egress_destination_not_allowed']], caller);
        for (const caller of ['caller-missing-grant','caller-duplicate-grant']) await refusedBeforeConnect([[wire(), 'egress_configuration_invalid']], caller);
        await refusedBeforeConnect([[wire({ url: 'https://second.example.com/' }), 'egress_destination_not_allowed']], 'caller-narrow');
        await refusedBeforeConnect([[wire(), 'egress_destination_not_allowed']], 'caller-listed');
        edge.state.answers.set('hooks.allowed.example', [[pinned]]);
        assert.equal((await one(wire({ url: 'https://hooks.allowed.example/' }), 'caller-listed')).error, 'egress_connection_failed', 'listed host proceeds to the pinned socket');
        // The deployable Worker refuses before DNS, so no resolver or destination fetch happens here.
        for (const [w, code] of [[wire({ url: 'https://127.0.0.1/' }), 'egress_destination_refused'], [wire({ url: 'http://receiver.example.com/' }), 'egress_destination_refused'],
          [wire({ headers: { host: 'x' } }), 'egress_header_forbidden'], [wire({ body: 'x'.repeat(REQUEST_BODY_LIMIT + 1) }), 'egress_request_too_large']] as const)
          assert.equal((await one(w, 'caller-deployable')).error, code);
        assert.deepEqual(deployedOutbound.urls, []);
      });

      await step('timeouts close a late connection, stalled handshake and blocked write without a late request', async () => {
        edge.state.routes.set(pinned, receiver.port);
        const before = receiver.requests.length;
        edge.state.connectDelayMs = 1800;
        assert.equal((await one(wire())).error, 'egress_request_timeout');
        await new Promise(resolve => setTimeout(resolve, 500));
        edge.state.connectDelayMs = 0;
        assert.equal(receiver.requests.length, before);
        assert.equal(receiver.activeConnections, 0);
        edge.state.stallWriteAfter = 2;
        assert.equal((await one(wire())).error, 'egress_request_timeout');
        edge.state.stallWriteAfter = null;
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(receiver.requests.length, before);
        assert.equal(receiver.activeConnections, 0);
        const sockets = new Set<import('node:net').Socket>(), records: Buffer[] = [];
        const silent = net.createServer(socket => {
          sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
          socket.on('data', bytes => records.push(bytes));
        });
        await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
        try {
          edge.state.routes.set(pinned, (silent.address() as import('node:net').AddressInfo).port);
          assert.equal((await one(wire())).error, 'egress_request_timeout');
          await new Promise(resolve => setTimeout(resolve, 50));
          assert.equal(sockets.size, 0);
          const handshake = Buffer.concat(records);
          assert.equal(handshake[0], 22, 'the real TLS ClientHello reached the silent peer');
          assert.ok(handshake.length > 5);
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>(resolve => silent.close(() => resolve()));
          edge.state.routes.set(pinned, receiver.port);
        }
      });

      await step('no fallback: a failing socket fails the call and global fetch is never used', async () => {
        edge.state.failConnect = true;
        const before = edge.state.connects.length;
        assert.equal((await one(wire())).error, 'egress_connection_failed');
        assert.equal(edge.state.connects.length, before + 1);
        edge.state.failConnect = false;
        assert.deepEqual(outbound.urls, [], 'the egress Worker made no ordinary fetch to any destination');
      });
    } finally {
      await runtime.dispose();
      await Promise.all([receiver.close(), wrongHost.close(), untrusted.close(), expired.close(), modules.cleanup()]);
      await certs.cleanup();
    }
  });

  }]]);
})
