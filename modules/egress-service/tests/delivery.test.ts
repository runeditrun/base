import { installD1Preflight } from '../../container/adapters/d1-workerd-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificates, testTls, egressModules, networkEdge, outboundRecorder, tlsReceiver, worker } from './fixture.ts';
import { workerModules } from '../build.mjs';
import { createDevEgress } from '../testing/dev-egress.ts';
import { nodeLoopbackSockets } from '../testing/node-socket.mjs';
import { DeliveryService, IntegrationsRepository, createWebhookProtocol, verifyWebhook } from '../../integrations/index.ts';
import { SqliteDatabase } from '../../integrations/core/sqlite.ts';
import { deniedAddresses, literalUrl } from '../../integrations/tests/core/public-address-cases.ts';

const certs = await certificates();

const miniflare = await import(process.env.INTEGRATIONS_MINIFLARE_MODULE ?? 'miniflare');
installD1Preflight(miniflare.D1_PLUGIN);
const { Miniflare } = miniflare;

const host = 'receiver.example.com', url = `https://${host}/hooks/delivery`, tenant = 'installation', destinationId = 'dest-v1';
const key = new Uint8Array(32).fill(9); // Test-only signing key.
const schema = await readFile(new URL('../../integrations/core/schema.sql', import.meta.url), 'utf8');

/** A seed's receiver: raw-byte HMAC verification, then the durable replay inbox before any effect. */
async function seedReceiver() {
  const directory = await mkdtemp(join(tmpdir(), 'egress-receiver-'));
  const sql = new SqliteDatabase(join(directory, 'inbox.sqlite')); sql.migrate(schema);
  const inbox = new IntegrationsRepository(sql, tenant), effects: string[] = [], replays: string[] = [];
  const receiver = await tlsReceiver(certs.receiver, async request => {
    try {
      const verified = await verifyWebhook({ body: new Uint8Array(request.body), headers: request.headers, key, tenant, destinationId });
      if (await inbox.acceptReplay(verified)) effects.push(verified.envelope.id); else replays.push(verified.envelope.id);
      return 'HTTP/1.1 204 No Content\r\n\r\n';
    } catch { return 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'; }
  });
  return { receiver, effects, replays, async close() { await receiver.close(); sql.close(); await rm(directory, { recursive: true, force: true }); } };
}

const seedWorker = `
import { DeliveryService, D1SqlDatabase, IntegrationsRepository, createWebhookProtocol } from './integrations/index.ts';
const key = new Uint8Array(${JSON.stringify([...key])});
export default { async fetch(request, env) {
  const { envelope, url, now, replay } = await request.json();
  const protocol = createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key });
  // The seed hands Base's DeliveryService its service binding as the TrustedTransport, unchanged.
  if (replay) return Response.json(await env.INTEGRATION_EGRESS.send(await protocol.prepare(envelope, now)));
  const service = new DeliveryService({ repository: new IntegrationsRepository(new D1SqlDatabase(env.DB), '${tenant}'),
    protocols: [protocol], transport: env.INTEGRATION_EGRESS, now: () => now });
  await service.enqueue(envelope);
  await service.dispatch(envelope.id);
  return Response.json({ delivery: await service.get(envelope.id), log: await service.log(envelope.id) });
} };`;

test('a seed-shaped delivery: Base DeliveryService and webhook protocol through the real service binding', async () => {
  const seed = await seedReceiver(), edge = networkEdge(), outbound = outboundRecorder(), modules = await egressModules(certs.ca);
  const persistence = await mkdtemp(join(tmpdir(), 'egress-seed-d1-'));
  edge.state.answers.set(host, [['93.184.216.34']]);
  edge.state.routes.set('93.184.216.34', seed.receiver.port);
  const seedModules = Object.fromEntries(Object.entries({ ...await workerModules(new URL('../../integrations/index.ts', import.meta.url).pathname), 'seed.js': seedWorker })
    .map(([name, contents]) => [name, { type: 'esm' as const, contents }]));
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: persistence, workers: [
    worker('seed', { mainModule: 'seed.js', modules: seedModules }, { DB: { type: 'd1', id: 'seed-db' }, INTEGRATION_EGRESS: { type: 'worker', worker: 'egress' } }),
    worker('egress', modules.test, { EDGE: { type: 'fetcher', handler: edge.handler } }, outbound.service),
  ] });
  try {
    const db = await runtime.getD1Database('DB', 'seed');
    await db.batch(schema.split(';').filter(statement => statement.trim()).map(statement => db.prepare(statement)));
    const now = Date.now(), envelope = { id: 'evt-seed-1', tenant, destinationId, event: 'issue.created', protocol: 'webhook', body: '{"issue":"Ünïcode ✓"}' };
    const post = async (body: unknown) => (await (await runtime.getWorker('seed')).fetch('http://seed/', { method: 'POST', body: JSON.stringify(body) })).json();
    const { delivery } = await post({ envelope, url, now });
    assert.equal(delivery.state, 'accepted');
    assert.deepEqual(seed.effects, ['evt-seed-1'], 'the receiver verified the HMAC and applied the effect once');
    assert.deepEqual(await post({ envelope, url, now, replay: true }), { status: 204, headers: {}, body: '' });
    assert.deepEqual(seed.replays, ['evt-seed-1'], 'a replayed delivery is recorded and its effect not reapplied');
    assert.deepEqual(seed.effects, ['evt-seed-1']);
    assert.deepEqual(edge.state.connects, ['93.184.216.34', '93.184.216.34']);
    assert.deepEqual(outbound.urls, []);
  } finally {
    await runtime.dispose();
    await Promise.all([seed.close(), modules.cleanup(), rm(persistence, { recursive: true, force: true })]);
  }
});

test('the same flow through the dev double, which also applies the service refusal table', async () => {
  const seed = await seedReceiver(), directory = await mkdtemp(join(tmpdir(), 'egress-dev-'));
  const sql = new SqliteDatabase(join(directory, 'outbound.sqlite')); sql.migrate(schema);
  const tls = await testTls(certs.ca);
  const openSocket = nodeLoopbackSockets();
  try {
    const egress = createDevEgress({ receivers: { [host]: { port: seed.receiver.port } }, openSocket, tls });
    const now = Date.now();
    const service = new DeliveryService({ repository: new IntegrationsRepository(sql, tenant), now: () => now, transport: egress,
      protocols: [createWebhookProtocol({ resolveDestination: async () => url, signingKey: async () => key })] });
    const envelope = { id: 'evt-dev-1', tenant, destinationId, event: 'issue.created', protocol: 'webhook', body: '{"issue":"dev double"}' };
    await service.enqueue(envelope);
    assert.equal((await service.dispatch(envelope.id))?.state, 'accepted');
    assert.deepEqual(seed.effects, ['evt-dev-1']);
    assert.equal(seed.receiver.requests[0]?.servername, host);

    const receivers = Object.fromEntries(deniedAddresses.flatMap((address, i) => [
      [`d${i}.example.com`, { port: seed.receiver.port, answers: [address] }],
      [`m${i}.example.com`, { port: seed.receiver.port, answers: ['8.8.8.8', address] }],
    ]));
    const refusing = createDevEgress({ receivers, openSocket, tls });
    const wire = (target: string) => ({ url: target, headers: {}, body: '{}' });
    for (const name of Object.keys(receivers)) await assert.rejects(refusing.send(wire(`https://${name}/`)), { message: 'egress_dns_not_public' });
    for (const address of deniedAddresses) await assert.rejects(refusing.send(wire(literalUrl(address))), { message: 'egress_destination_refused' });
    await assert.rejects(refusing.send(wire('https://unlisted.example.com/')), { message: 'egress_dns_failed' });
    assert.deepEqual(refusing.connects, []);
    const narrowed = createDevEgress({ receivers: { [host]: { port: seed.receiver.port } }, openSocket, tls, allowedHosts: ['*.example.org'] });
    await assert.rejects(narrowed.send(wire(url)), { message: 'egress_destination_not_allowed' });
    assert.equal(seed.receiver.requests.length, 1);
  } finally { sql.close(); await seed.close(); await rm(directory, { recursive: true, force: true }); }
});
