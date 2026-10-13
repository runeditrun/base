import test from 'node:test';
import assert from 'node:assert/strict';
import { NodePinnedTransport } from '../../core/node-transport.ts';
import { DeliveryService } from '../../core/index.ts';
import type { DeliveryProtocol } from '../../core/types.ts';
import { tlsReceiver } from './tls-fixture.ts';
import { database } from './support.ts';

test('real TLS terminal response failures cannot resolve success or authorize an automatic resend', async t => {
  let calls = 0;
  const receiver = await tlsReceiver((req, res) => {
    calls++; req.resume();
    if (req.url === '/oversized') { res.writeHead(200, { 'content-length': 2048 }); res.end(Buffer.alloc(2048, 'x')); }
    else if (req.url === '/exact') { res.writeHead(200, { 'content-length': 1024 }); res.end(Buffer.alloc(1024, 'x')); }
    else if (req.url === '/truncated') { res.writeHead(200, { 'content-length': 2048 }); res.write('incomplete'); res.socket!.end(); }
    else if (req.url === '/stalled') { res.writeHead(200); res.write('waiting'); }
    else { res.writeHead(200); res.write(Buffer.alloc(600, 'x')); res.end(Buffer.alloc(600, 'y')); }
  });
  try {
    await t.test('oversized final TLS chunk rejects immediately instead of resolving an empty 200 body', async () => {
      const transport = new NodePinnedTransport({ maxResponseBytes: 1024 });
      await assert.rejects(transport.send({ url: `${receiver.url}/oversized`, headers: {}, body: '{}' }), /Response limit exceeded/);
    });
    await t.test('exact response limit succeeds without truncation', async () => {
      const transport = new NodePinnedTransport({ maxResponseBytes: 1024 });
      const response = await transport.send({ url: `${receiver.url}/exact`, headers: {}, body: '{}' });
      assert.equal(response.status, 200); assert.equal(response.body, 'x'.repeat(1024));
    });
    await t.test('chunked overflow, partial response and absolute timeout all reject', async () => {
      const transport = new NodePinnedTransport({ maxResponseBytes: 1024, timeoutMs: 300 });
      await assert.rejects(transport.send({ url: `${receiver.url}/chunked`, headers: {}, body: '{}' }), /Response limit exceeded/);
      await assert.rejects(transport.send({ url: `${receiver.url}/truncated`, headers: {}, body: '{}' }), /aborted|incomplete|closed/);
      await assert.rejects(transport.send({ url: `${receiver.url}/stalled`, headers: {}, body: '{}' }), /Transport timeout/);
    });
    await t.test('overflow persists uncertain without classification and remains unsent after restart', async () => {
      const store = await database(); let classifications = 0;
      const protocol: DeliveryProtocol = {
        id: 'tls-test', async prepare(envelope) { return { url: `${receiver.url}/oversized`, headers: {}, body: envelope.body }; },
        classify(response) { classifications++; return { kind: 'accepted', status: response.status, code: 'acknowledged' }; },
      };
      const makeService = () => new DeliveryService({ repository: store.repo(), protocols: [protocol], transport: new NodePinnedTransport({ maxResponseBytes: 1024 }) });
      try {
        let service = makeService(); const before = calls;
        await service.enqueue({ id: 'limit-event', tenant: 'tenant', destinationId: 'receiver', event: 'created', protocol: protocol.id, body: '{}' });
        assert.equal((await service.dispatch('limit-event'))!.state, 'uncertain');
        assert.equal(classifications, 0); assert.equal(calls, before + 1);
        assert.deepEqual((await service.log('limit-event'))[0]!.outcome, { kind: 'uncertain', code: 'response_unknown' });
        store.restart(); service = makeService();
        await service.dispatch('limit-event'); assert.deepEqual(await service.dispatchDue(), []);
        assert.equal(calls, before + 1); assert.equal((await service.log('limit-event')).length, 1);
      } finally { await store.close(); }
    });
    // All request sockets must close from success/failure handling, before fixture cleanup.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(receiver.sockets.size, 0);
  } finally { await receiver.close(); }
});
