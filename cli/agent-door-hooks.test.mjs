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
import { checkAgentDoor } from './agent-door.mjs';
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
 const hosted = await serveHosted(root, { bindings: { RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN, RER_OWNER_CLAIM_ISSUER: 'https://issuer.invalid', RER_OWNER_CLAIM_INSTALLATION_ID: 'disposable', RER_OWNER_CLAIM_PUBLIC_KEYS: '{}', OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: crypto.randomUUID() + crypto.randomUUID() } });
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


test('an explicitly declared single sponsor preserves the native owner lifecycle and point count', { timeout: 120000 }, async t => {
 const results = [];
 for (const labelled of [false, true]) {
  const root = await fixtureSeed(t, 'native');
  if (labelled) {
   const path = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(path, 'utf8'));
   surface.verification.sponsors = [{ label: 'primary' }];
   await writeFile(path, JSON.stringify(surface));
  }
  await buildFixture(root);
  const result = await checkAgentDoor(root, { report: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.points.some(point => point.id.includes('cross-sponsor')), false);
  results.push(result.points.length);
 }
 assert.equal(results[0], results[1]);
 t.diagnostic(`Native owner: default ${results[0]}/${results[0]}, explicitly labelled single sponsor ${results[1]}/${results[1]}; original bootstrap inputs preserved.`);
});

test('a declared agent initializer binds each chosen ID through the person door before transport and refuses invalid modules', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed', { sponsors: true });
 const path = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(path, 'utf8'));
 await writeFile(join(root, 'not-a-function.mjs'), 'export default {};');
 for (const agent of [{ initializer: '../outside.mjs' }, { initializer: resolve(root, 'not-a-function.mjs') }, { initializer: 'not-a-function.mjs' }, { initializer: 'not-a-function.mjs', extra: true }, null]) {
  surface.verification.agent = agent;
  await writeFile(path, JSON.stringify(surface));
  await assert.rejects(() => checkAgentDoor(root, { report: () => {} }), error => error.code === 'agent_initializer_invalid');
 }
 await writeFile(join(root, 'owner-state.mjs'), `
 export let database;
 export default async context => {
  database = await context.database('DB');
  return context.request(context.origin + context.claim.path, { method: 'POST', redirect: 'manual',
   headers: { Origin: context.origin, 'Content-Type': 'application/json' },
   body: JSON.stringify({ token: context.claim.token, displayName: context.displayName, returnTo: context.returnTo }) });
 };
 `);
 await writeFile(join(root, 'agent-initializer.mjs'), `
 import assert from 'node:assert/strict';
 import { database } from './owner-state.mjs';
 export const agents = [];
 export const privateValue = crypto.randomUUID();
 let failure;
 export const failFor = email => { failure = email; };
 export default async context => {
  assert.deepEqual(Object.keys(context).sort(), ['agentId', 'email', 'fixtures', 'mail', 'origin', 'request', 'sub']);
  const { agentId, email, sub, request, origin, mail, fixtures } = context;
  assert.equal(typeof sub, 'string');
  assert.equal(typeof mail.read, 'function');
  assert.equal(typeof fixtures.set, 'function');
  if (email === failure) throw new Error(privateValue + JSON.stringify(mail.read()));
  assert.equal(agents.some(agent => agent.agentId === agentId), false);
  await assert.rejects(async () => request('https://outside.invalid/app'));
  const created = await request(origin + '/app/records', { method: 'POST',
   headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ value: agentId }).toString() });
  assert.equal(created.status, 303); await created.body?.cancel();
  const proof = await request(origin + '/app/native-proof', { method: 'POST',
   body: JSON.stringify({ tool: 'fixture.records.protected', id: agentId, agentId }) });
  assert.equal(proof.status, 200); await proof.body?.cancel();
  const binding = await database.prepare('SELECT p.agent,o.email FROM fixture_proofs p JOIN oa_operators o ON o.id=p.operator_id WHERE p.agent=?').bind(agentId).first();
  assert.deepEqual(binding, { agent: agentId, email });
  const record = await database.prepare('SELECT o.email FROM fixture_records r JOIN oa_operators o ON o.id=r.operator_id WHERE r.value=?').bind(agentId).first();
  assert.equal(record.email, email);
  agents.push({ agentId, email, sub });
 };
 `);
 surface.verification.owner.initializer = 'owner-state.mjs';
 surface.verification.agent = { initializer: 'agent-initializer.mjs' };
 await writeFile(path, JSON.stringify(surface));
 await buildFixture(root);
 const requests = [], originalFetch = globalThis.fetch;
 globalThis.fetch = (input, init) => {
  const url = new Headers(init?.headers).get('x-rer-original-url');
  if (url) requests.push(new URL(url).pathname);
  return originalFetch(input, init);
 };
 let result;
 try { result = await checkAgentDoor(root, { report: () => {} }); }
 finally { globalThis.fetch = originalFetch; }
 const hook = await import(new URL('agent-initializer.mjs', 'file://' + root + '/'));
 assert.equal(result.ok, true);
 assert.equal(hook.agents.length, surface.verification.sponsors.length);
 assert.equal(new Set(hook.agents.map(agent => agent.agentId)).size, hook.agents.length);
 assert.deepEqual(hook.agents.map(agent => agent.email), ['synthetic-base-1@example.com', 'synthetic-member@example.com']);
 assert.ok(requests.indexOf('/app/native-proof') < requests.indexOf('/mcp'));
 const audits = result.points.filter(point => point.id.startsWith('BASE-AGENT-009.1.') || point.id === 'BASE-AGENT-007.7.differs-from-policy' || point.id.includes('cross-sponsor'));
 assert.ok(audits.length > 0 && audits.every(point => point.ok));
 t.diagnostic('Native request order: ' + requests.slice(0, requests.indexOf('/mcp') + 1).join(' -> '));
 for (const email of ['synthetic-base-1@example.com', 'synthetic-member@example.com']) {
  hook.failFor(email);
  const lines = [];
  await assert.rejects(() => checkAgentDoor(root, { report: line => lines.push(line) }), error => {
   assert.deepEqual(error.failures, ['BASE-AGENT-001.agent-initializer']);
   return error.code === 'agent_door_failed';
  });
  assert.equal(lines.join('\n').includes(hook.privateValue), false);
 }
});

test('additional sponsors confirm their own captured mail without reading another principal mailbox', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'native', { sponsors: true });
 const path = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(path, 'utf8'));
 await writeFile(join(root, 'mail-owner.mjs'), `
 import initialize from './initializer.mjs';
 export let mail;
 export default async context => { mail = context.mail; return initialize(context); };
 `);
 await writeFile(join(root, 'mail-sponsor.mjs'), String.raw`
 import assert from 'node:assert/strict';
 import { confirmMail } from './confirm-mail.mjs';
 export const mailboxes = [];
 export default async context => {
  const { mail } = context;
  assert.deepEqual(Object.keys(mail), ['read']);
  // Business sent both invitations before either additional initializer runs;
  // the owner's native confirmation also already exists in this installation.
  assert.equal(mail.read({ limit: 20 }).length, 1);
  assert.throws(() => mail.read({ limit: 21 }));
  assert.throws(() => mail.read({ maxAgeMs: 300001 }));
  const invitation = new URL(mail.read({ limit: 1 })[0].text.match(/https:\/\/[^\s]+/)[0]);
  const admitted = await context.request(context.origin + '/auth/confirm', { method: 'POST', redirect: 'manual',
   headers: { Origin: context.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitation.searchParams.get('token') }) });
  assert.equal(admitted.status, 303);
  await admitted.body?.cancel();
  const response = await confirmMail(context);
  const messages = mail.read({ limit: 20 });
  assert.equal(messages.length, 2);
  assert.deepEqual(mail.read({ limit: 20, email: context.owner.email }), messages);
  mailboxes.push({ mail, messages });
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const linked = await context.request(context.origin + '/app/membership/link', { method: 'POST',
   headers: { Origin: context.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(linked.status, 200);
  await linked.body?.cancel();
  return response;
 };
 `);
 surface.verification.owner.initializer = 'mail-owner.mjs';
 surface.verification.sponsors[1].initializer = 'mail-sponsor.mjs';
 surface.verification.sponsors.push({ label: 'admin', role: 'admin', email: 'synthetic-admin@example.com', initializer: 'mail-sponsor.mjs' });
 await writeFile(path, JSON.stringify(surface));
 await buildFixture(root);
 const result = await checkAgentDoor(root, { report: () => {} });
 assert.equal(result.ok, true);
 const cross = result.points.filter(point => point.id.startsWith('BASE-AGENT-004.cross-sponsor.'));
 for (const label of ['member', 'admin']) assert.ok(cross.some(point => point.id === `BASE-AGENT-004.cross-sponsor.${label}.binding` && point.ok));
 assert.ok(cross.every(point => point.ok));
 const { mailboxes } = await import(new URL('mail-sponsor.mjs', 'file://' + root + '/'));
 assert.equal(mailboxes.length, 2);
 const [first, second] = mailboxes.map(({ messages }) => messages.map(message => message.text));
 assert.ok(first.every(text => !second.includes(text)), 'Distinct sponsors must never receive each other\'s confirmation proofs');
 const owner = await import(new URL('mail-owner.mjs', 'file://' + root + '/'));
 for (const mail of [owner.mail, ...mailboxes.map(entry => entry.mail)]) assert.throws(() => mail.read(), /active run/);
 t.diagnostic(`Native captured-mail sponsors: ${cross.length}/${cross.length} cross-sponsor points; isolated invitation and confirmation readers destroyed on close.`);
});
