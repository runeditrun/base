import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { createAgentConformanceNetwork } from './agent-network.mjs';
import { serveHosted, HOSTED_ORIGIN } from './hosted-output.mjs';
import { deliveryRequest, verifyDeliveryReceipt } from './tests/fixtures/agent-door/receiver.mjs';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';
import { registry } from '../modules/agent-door/registry.ts';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('multi-sponsor public-door phase verifies private native records and approvals in all three owner modes', { timeout: 240000 }, async t => {
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 for (const mode of ['signed', 'setup-token', 'native']) {
  const root = await fixtureSeed(t, mode, { sponsors: true });
  const { stdout, stderr } = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 75000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.ok, true, stdout + stderr);
  const cross = result.agentDoor.points.filter(point => point.id.includes('cross-sponsor'));
  assert.ok(cross.length > 0);
  assert.ok(cross.every(point => point.ok));
  t.diagnostic(`${mode} two sponsors: ${result.agentDoor.points.filter(point => point.ok).length}/${result.agentDoor.points.length}; native privacy, approval and attribution passed.`);
 }
});

test('record-only security follows native policy and approval, refuses widening and validates its declaration', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed', { security: true });
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 const { stdout, stderr } = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 75000, maxBuffer: 4 * 1024 * 1024 });
 const result = JSON.parse(stdout.trim().split('\n').at(-1));
 assert.equal(result.ok, true, stdout + stderr);
 assert.ok(result.agentDoor.points.some(point => point.id === 'BASE-AGENT-005.1.invite-self' && point.ok));
 assert.ok(result.agentDoor.points.some(point => point.id === 'BASE-AGENT-006.2.autonomous.narrow' && point.ok));
 assert.ok(result.agentDoor.points.some(point => point.id.includes('no-subject') && point.id.endsWith('negative-declaration') && point.ok));
 assert.ok(result.agentDoor.points.some(point => point.id === 'BASE-AGENT-012.replay.audit' && point.ok));
 assert.ok(result.agentDoor.points.some(point => point.id === 'BASE-AGENT-006.webhook.valid' && point.ok));
 assert.ok(result.agentDoor.points.some(point => point.id === 'BASE-AGENT-006.webhook.invalid' && point.ok));
 t.diagnostic(`replay admission, record-only security and inbound webhook: ${result.agentDoor.points.filter(point => point.ok).length}/${result.agentDoor.points.length}; policy, approval, smuggling refusal, audit and negative declaration passed.`);
});

test('per-install secret source provisions isolated receiver and wrong signatures remain refused', { timeout: 45000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 await buildFixture(root);
 const hosted = await serveHosted(root, { bindings: { RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN, RER_OWNER_CLAIM_ISSUER: 'https://issuer.invalid', RER_OWNER_CLAIM_INSTALLATION_ID: 'disposable', RER_OWNER_CLAIM_PUBLIC_KEYS: '{}', OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: 'synthetic-disposable-setup-token-with-32-bytes' } });
 const config = { module: 'provider.mjs', origins: ['https://receiver.example.invalid'], secretSource: 'secret-source.mjs' };
 const network = await createAgentConformanceNetwork(root, config);
 try {
  // The native initializer creates a fresh installation secret even when owner
  // admission is unavailable. No key or production route is supplied by tests.
  const response = await hosted.fetch('app', { method: 'GET' }); await response.body?.cancel();
  const database = await hosted.database('DB');
  const { secret } = await database.prepare('SELECT secret FROM fixture_installation WHERE id=1').first();
  await network.provision(hosted);
  const record = { id: 'reference-record', value: 'A signed native record' }, deliveryId = crypto.randomUUID();
  const correct = await network.fetch(await deliveryRequest(record, deliveryId, secret));
  assert.equal(correct.status, 202);
  assert.equal(await verifyDeliveryReceipt(await correct.json(), { deliveryId, recordId: record.id, value: record.value }, secret), true);
  const wrong = await network.fetch(await deliveryRequest(record, crypto.randomUUID(), 'wrong-key-from-a-different-installation'));
  assert.equal(wrong.status, 401); await wrong.body?.cancel();
  await assert.rejects(() => hosted.database('UNDECLARED'));
  assert.throws(() => database.prepare('DELETE FROM fixture_installation'), /read-only/);
  await writeFile(join(root, 'broken-source.mjs'), 'export default () => { throw new Error("never expose accessor values"); };');
  const broken = await createAgentConformanceNetwork(root, { ...config, secretSource: 'broken-source.mjs' });
  try { await assert.rejects(() => broken.provision(hosted), error => error.code === 'agent_secret_source_invalid' && !error.message.includes('never expose')); }
  finally { await broken.close(); }
  t.diagnostic('Per-run random secret: valid signature 202, wrong signature 401; read-only state and sanitized accessor failures passed.');
 } finally { await network.close(); await hosted.close(); }
});

test('no-subject schema validation rejects nested authority fields and open or opaque inputs', async t => {
 const root = await fixtureSeed(t, 'signed', { security: true });
 const surface = JSON.parse(await readFile(join(root, 'agent-surface.json'), 'utf8'));
 assert.equal(validateAgentSurface(surface).ok, true);
 const security = surface.tools.find(tool => tool.authority === 'none');
 for (const schema of [
  { type: 'object', properties: { role: { type: 'string' } }, additionalProperties: false },
  { type: 'object', properties: { settings: { type: 'object', properties: { personId: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false },
  { type: 'object', properties: { values: { type: 'array', items: { type: 'object', additionalProperties: true } } }, additionalProperties: false },
  { type: 'object', properties: { payload: {} }, additionalProperties: false },
 ]) {
  const invalid = structuredClone(surface);
  invalid.tools.find(tool => tool.authority === 'none').inputSchema = schema;
  assert.equal(validateAgentSurface(invalid).ok, false);
  assert.throws(() => registry({ seed: 'fixture', origin: 'https://fixture.invalid', tools: [{ ...security, title: 'TLS', description: 'Record TLS', inputSchema: schema, outputSchema: {}, summary: () => ({}), classify: () => [], run: async () => ({ result: {} }) }] }), /no-subject/);
 }
});
