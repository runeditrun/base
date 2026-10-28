import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { fixtureSeed, buildFixture, nativeBindings } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { serveHosted, HOSTED_ORIGIN } from './hosted-output.mjs';
const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('rer verify drives signed, setup-token and native owner lifecycles through isolated JSON, streaming and signed provider edges', { timeout: 330000 }, async t => {
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 for (const mode of ['signed', 'setup-token', 'native']) {
  const root = await fixtureSeed(t, mode);
  const { stdout, stderr } = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 100000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.ok, true, stderr + stdout);
  assert.equal(result.agentDoor.ok, true, stdout);
  // Binding names are reported; the per-run issuer and other minted values never are.
  assert.match(stdout, /native bindings FIXTURE_MANAGEMENT_ORIGIN \(issuer\), FIXTURE_INSTALLATION_ID \(installationId\)/);
  assert.doesNotMatch(stdout, /synthetic-base-1-[0-9a-f-]{36}\.invalid/);
  const durable = result.agentDoor.points.filter(point => point.id.startsWith('BASE-AGENT-004.durable.'));
  assert.ok(durable.some(point => point.id.endsWith('.revoked')) && durable.every(point => point.ok), stdout);
  t.diagnostic(`${mode}: rer verify PASS; ${result.agentDoor.points.filter(point => point.ok).length}/${result.agentDoor.points.length} conformance points (${durable.length} durable consent); native bindings, JSON/SSE, signed receiver, undeclared 502 and adapter network denial completed.`);
  if (mode === 'signed') {
   // This is outside the runner: the same production signed route with its
   // trusted configuration must still refuse a bare setup token.
   const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
   const rawToken = 'fixture-raw-setup-token-at-least-32-bytes';
   const installationId = randomUUID();
   const hosted = await serveHosted(root, { bindings: { OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: rawToken,
    RER_OWNER_CLAIM_ISSUER: 'https://issuer.example.invalid', RER_OWNER_CLAIM_INSTALLATION_ID: installationId, RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
    RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ fixture: await webcrypto.subtle.exportKey('jwk', pair.publicKey) }),
    FIXTURE_MANAGEMENT_ORIGIN: 'https://issuer.example.invalid', FIXTURE_INSTALLATION_ID: installationId,
   } });
   try {
    const denied = await hosted.fetch('auth/owner-claim', { method: 'POST', headers: { Origin: hosted.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: rawToken, displayName: 'Owner' }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'invalid_claim');
    t.diagnostic('Outside runner: raw owner token HTTP 403 invalid_claim.');
   } finally { await hosted.close(); }
  }
 }
});

test('rer verify binds only the native names a seed declares', { timeout: 120000 }, async t => {
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 const { FIXTURE_INSTALLATION_ID: _undeclared, ...partial } = nativeBindings;
 const root = await fixtureSeed(t, 'signed', partial);
 const failure = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 75000, maxBuffer: 4 * 1024 * 1024 }).then(() => null, error => error);
 assert.ok(failure, 'verify must fail without the undeclared installation binding');
 assert.match(failure.stdout, /BASE-AGENT-001\.owner-bootstrap: Native owner bootstrap returned HTTP 503/);
 assert.doesNotMatch(failure.stdout, /synthetic-base-1-[0-9a-f-]{36}\.invalid/);
 t.diagnostic('One declared binding: the undeclared FIXTURE_INSTALLATION_ID was not injected; bootstrap HTTP 503, no writes, no minted value printed.');
});

test('rer verify refuses provider modules that import Node APIs or escape the seed', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed'), env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 await buildFixture(root);
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 await writeFile(join(root, 'node-api.mjs'), "import fs from 'node:fs'; export default {fetch(){return new Response(fs.readFileSync('/etc/hosts'))}}\n");
 await symlink(join(base, 'cli/agent-network.mjs'), join(root, 'escape.mjs'));
 for (const module of ['node-api.mjs', 'escape.mjs']) {
  surface.verification.network.module = module;
  await writeFile(surfaceFile, JSON.stringify(surface));
  const failure = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 50000, maxBuffer: 4 * 1024 * 1024 }).then(() => null, error => error);
  assert.ok(failure, module);
  const events = failure.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.code === 'agent_network_invalid'), failure.stdout + failure.stderr);
 }
});
