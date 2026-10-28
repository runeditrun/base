import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { serveHosted, HOSTED_ORIGIN } from './hosted-output.mjs';
const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('rer verify drives signed, setup-token and native owner lifecycles through isolated JSON, streaming and signed provider edges', { timeout: 240000 }, async t => {
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 for (const mode of ['signed', 'setup-token', 'native']) {
  const root = await fixtureSeed(t, mode);
  const { stdout, stderr } = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 75000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.ok, true, stderr + stdout);
  assert.equal(result.agentDoor.ok, true, stdout);
  t.diagnostic(`${mode}: rer verify PASS; ${result.agentDoor.points.length} conformance points; JSON/SSE, signed receiver, undeclared 502 and adapter network denial completed.`);
  if (mode === 'signed') {
   // This is outside the runner: the same production signed route with its
   // trusted configuration must still refuse a bare setup token.
   const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
   const rawToken = randomBytes(32).toString('hex');
   const hosted = await serveHosted(root, { bindings: { OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: rawToken,
    RER_OWNER_CLAIM_ISSUER: 'https://issuer.example.invalid', RER_OWNER_CLAIM_INSTALLATION_ID: randomUUID(), RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
    RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ fixture: await webcrypto.subtle.exportKey('jwk', pair.publicKey) }),
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
