import { runCases, type Case } from '../cases.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verifyWebhook } from '../../index.ts';
import { store } from './support.ts';
import { key, tenant, destinationId, signedWebhook, byteMutations } from './raw-webhook-fixture.ts';

test("raw webhook verification binds exact bytes to audience, freshness and durable replay identity", async t => {
  const foldedCases: Case[] = [];
foldedCases.push(['raw webhook bytes reject UTF-8 replacement and BOM mutations hidden by Request.text()', async (t) => {
  await runCases(t, Array.from(byteMutations, (mutation, rowIndex) => [`${t.name}: mutation row ${rowIndex + 1}`, async t => {
    const signed = signedWebhook(mutation.original);
    const request = new Request('https://receiver.example.com/', { method: 'POST', headers: signed.headers, body: mutation.body });
    assert.equal(await request.clone().text(), mutation.original, 'lossy text is identical to signed text');
    await assert.rejects(verifyWebhook({ body: new Uint8Array(await request.arrayBuffer()), headers: request.headers, key, tenant, destinationId }), mutation.name);
    assert.equal((await verifyWebhook({ ...signed, key, tenant, destinationId })).envelope.body, mutation.original);
}]));
}]);
foldedCases.push(['raw verifier preserves exact Unicode, byte views and owned strings without normalization', async (t) => {
  await runCases(t, Array.from(['', '{"text":"Café λ 🚀 𐐷 e\u0301 \ufffd \\uFEFF"}', '\ufeff{"text":"signed BOM"}'], (body, rowIndex) => [`${t.name}: body row ${rowIndex + 1}`, async t => {
    const signed = signedWebhook(body);
    const storage = new Uint8Array(signed.body.length + 2).fill(0xff);
    storage.set(signed.body, 1);
    const view = storage.subarray(1, -1);
    const pending = verifyWebhook({ ...signed, body: view, key, tenant, destinationId });
    view.fill(0); // Authentication snapshots body text before any asynchronous crypto.
    const raw = await pending;
    const text = await verifyWebhook({ ...signed, body, key, tenant, destinationId });
    assert.equal(raw.envelope.body, body);
    assert.equal(raw.fingerprint, text.fingerprint);
}]));
  const composed = signedWebhook('{"text":"é"}');
  await assert.rejects(verifyWebhook({ ...composed, body: new TextEncoder().encode('{"text":"e\u0301"}'), key, tenant, destinationId }), /signature/);
  const unpaired = '\ud800';
  await assert.rejects(verifyWebhook({ ...signedWebhook(unpaired), body: unpaired, key, tenant, destinationId }), /UTF-8/);
}]);
foldedCases.push(['native HTTP raw receiver protects its durable inbox across invalid bytes, audience, freshness and restart', async t => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  // This clock spans nested rows; restore it at the owning row's cleanup.
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const inbox = await store(t);
  const server = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const verified = await verifyWebhook({ body: Buffer.concat(chunks), headers, key, tenant, destinationId });
      await inbox.repo().acceptReplay(verified);
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const send = (wire: ReturnType<typeof signedWebhook>) => fetch(url, { method: 'POST', ...wire });
  const rows = () => inbox.repo().query('SELECT * FROM integration_replays WHERE namespace=?');
  await runCases(t, Array.from(byteMutations, (mutation, rowIndex) => [`${t.name}: mutation row ${rowIndex + 1}`, async t => {
    assert.equal((await send({ ...signedWebhook(mutation.original), body: mutation.body })).status, 400);
}]));
  assert.equal((await rows()).length, 0, 'invalid bytes never enter the durable inbox');
  const body = '{"text":"Café λ 🚀 e\u0301 \ufffd"}', signed = signedWebhook(body);
  assert.equal((await send({ ...signed, headers: { ...signed.headers, 'webhook-signature': `v1=${'0'.repeat(64)}` } })).status, 400);
  assert.equal((await rows()).length, 0, 'tampered signature never enters the durable inbox');
  assert.equal((await send(signed)).status, 204);
  assert.equal((await rows()).length, 1);
  inbox.restart();
  assert.equal((await send(signed)).status, 204);
  assert.equal((await rows()).length, 1, 'duplicate remains one inbox record after restart');
  assert.equal((await send(signedWebhook('{"changed":true}'))).status, 400);
  await runCases(t, Array.from([{ tenant: 'other' }, { destinationId: 'other' }, { now: Date.now() - 301000 }, { now: Date.now() + 301000 }], (options, rowIndex) => [`${t.name}: options row ${rowIndex + 1}`, async t => {
    assert.equal((await send(signedWebhook(body, { id: 'rejected-event', ...options }))).status, 400);
}]));
  assert.equal((await send({ ...signed, headers: { ...signed.headers, 'webhook-event': 'incident.closed' } })).status, 400);
  assert.equal((await rows()).length, 1);
  await runCases(t, Array.from([-300000, 300000], (offset, rowIndex) => [`${t.name}: offset row ${rowIndex + 1}`, async t => {
    assert.equal((await send(signedWebhook(body, { id: `boundary-${offset}`, now: now + offset }))).status, 204, 'exact five-minute boundary is accepted');
}]));
  assert.equal((await rows()).length, 3);
}]);
foldedCases.push(['loopback receiver rejects signature tampering and replay with explicit HTTP errors after restart', async t => {
  const inbox = await store(t); let effects = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
      const verified = await verifyWebhook({ body: Buffer.concat(chunks), headers, key, tenant, destinationId });
      if (!await inbox.repo().acceptReplay(verified)) { response.writeHead(409).end(); return; }
      // This counter observes the policy boundary only; production domain effects
      // require the documented transactional inbox/processed-marker mechanism.
      effects++;
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (wire: ReturnType<typeof signedWebhook>) => fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', ...wire });
  const signed = signedWebhook('{"message":"once"}', { id: 'reject-replay' });
  assert.equal((await send({ ...signed, headers: { ...signed.headers, 'webhook-signature': `v1=${'0'.repeat(64)}` } })).status, 400);
  assert.equal(effects, 0);
  assert.equal((await inbox.repo().query('SELECT id FROM integration_replays WHERE namespace=?')).length, 0);
  assert.equal((await send(signed)).status, 204);
  assert.equal(effects, 1);
  assert.equal((await send(signed)).status, 409);
  inbox.restart();
  assert.equal((await send(signed)).status, 409);
  assert.equal(effects, 1);
  assert.equal((await inbox.repo().query('SELECT id FROM integration_replays WHERE namespace=?')).length, 1);
}]);
  await runCases(t, foldedCases);
});
