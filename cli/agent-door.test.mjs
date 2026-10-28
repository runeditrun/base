import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { serveHosted, HOSTED_ORIGIN } from './hosted-output.mjs';
import { checkAgentDoor } from './agent-door.mjs';
import { seconds, signJws } from '../modules/agent-door/conformance/crypto.mjs';
const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('rer verify drives signed, setup-token and native owner lifecycles through isolated JSON, streaming and signed provider edges', { timeout: 240000 }, async t => {
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 for (const mode of ['signed', 'setup-token', 'native']) {
  const root = await fixtureSeed(t, mode);
  const { stdout, stderr } = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 75000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.ok, true, stderr + stdout);
  assert.equal(result.agentDoor.ok, true, stdout);
  assert.doesNotMatch(stdout + stderr, /(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|operator_session=)/);
  for (const gap of ['narrowing', 'native-proof']) { const points = result.agentDoor.points.filter(point => point.id.includes(`.${gap}.`)); assert.ok(points.length > 0); t.diagnostic(`${mode}: ${gap} ${points.filter(point => point.ok).length}/${points.length} public-door points passed.`); }
  t.diagnostic(`${mode}: rer verify PASS; ${result.agentDoor.points.length} conformance points; JSON/SSE, signed receiver, undeclared 502 and adapter network denial completed.`);
  if (mode === 'signed') {
   const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
   delete surface.verification.owner.bindings;
   await writeFile(surfaceFile, JSON.stringify(surface));
   await assert.rejects(checkAgentDoor(root, { report() {} }), error => error.code === 'agent_door_failed'
    && error.agentDoor.points.some(point => !point.ok && point.detail.includes('HTTP 503')));
   t.diagnostic('Signed seed with two native bindings: omission returns HTTP 503; declared issuer and installation bindings complete the journey.');
   // This is outside the runner: the same production signed route with its
   // trusted configuration must still refuse a bare setup token.
   const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
   const rawToken = randomBytes(32).toString('hex');
   const issuer = 'https://issuer.example.invalid', installationId = randomUUID();
   const hosted = await serveHosted(root, { bindings: { OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: rawToken,
    RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId, RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
    RER_MANAGEMENT_ORIGIN: issuer, RER_INSTALLATION_ID: installationId,
    RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ fixture: await webcrypto.subtle.exportKey('jwk', pair.publicKey) }),
   } });
   try {
    const denied = await hosted.fetch('auth/owner-claim', { method: 'POST', headers: { Origin: hosted.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: rawToken, displayName: 'Owner' }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'invalid_claim');
    const iat = seconds(), claim = await signJws(pair.privateKey, 'fixture', 'rer-owner-claim+jwt', {
     v: 1, iss: issuer, aud: hosted.origin, installationId, email: 'synthetic-base-1@example.com', jti: randomUUID(), iat, exp: iat + 300,
    });
    const admitted = await hosted.fetch('auth/owner-claim', { method: 'POST', headers: { Origin: hosted.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: claim, displayName: 'Owner' }) });
    assert.equal(admitted.status, 303);
    const cookie = admitted.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    await admitted.body?.cancel();
    assert.ok(cookie);
    const session = await hosted.fetch('auth/session', { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).operator.role, 'owner');
    t.diagnostic('Outside runner: raw owner token HTTP 403 invalid_claim; signed claim then creates the owner/session with HTTP 303.');
   } finally { await hosted.close(); }
  }
 }
});

test('rer verify refuses provider modules that import Node APIs or escape the seed', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed'), env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 const build = await buildFixture(root);
 assert.ok(Object.keys(build.metafile.inputs).every(path => !/cli\/agent-(?:mail|fixtures)\.mjs$/.test(path)), 'Verifier mail and fixture control must be absent from the production dependency graph');
 const built = await readFile(join(root, 'dist/server/index.js'), 'utf8');
 assert.doesNotMatch(built, /rer-conformance-captured-mail|createCapturedMail|createFixtureControl/);
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

// A narrowing declaration is evidence only when its input cannot add authority.
test('narrowing declarations reject widening fields, open objects and hidden schema branches', async t => {
 const original = JSON.parse(await readFile(new URL('./tests/fixtures/agent-door/surface.json', import.meta.url), 'utf8'));
 assert.equal(validateAgentSurface(original).ok, true);
 const mutations = [
  schema => { schema.properties.grant_to_add = { type: 'string' }; },
  schema => { schema.additionalProperties = true; },
  schema => { schema.oneOf = [{ properties: { role: { type: 'string' } } }]; },
 ];
 for (const mutate of mutations) {
  const surface = structuredClone(original);
  mutate(surface.tools.find(tool => tool.widens === false).inputSchema);
  const validation = validateAgentSurface(surface);
  assert.ok(validation.points.some(point => point.id === 'BASE-AGENT-005.surface.fixture.access.revoke.narrowing-contract' && !point.ok));
  assert.equal(validation.ok, false);
 }
 const incomplete = structuredClone(original);
 delete incomplete.tools.find(tool => tool.widens === false).narrowing;
 assert.equal(validateAgentSurface(incomplete).ok, false);
 t.diagnostic(`Gap N negative declarations: ${mutations.length + 1}/${mutations.length + 1} refused.`);
});
