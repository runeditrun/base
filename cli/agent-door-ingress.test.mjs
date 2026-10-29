import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
import { checkAgentDoor } from './agent-door.mjs';
import { serveHosted, HOSTED_ORIGIN } from './hosted-output.mjs';
import { seconds, signJws } from '../modules/agent-door/conformance/crypto.mjs';

// Like an adopting seed's optional workforce sign-in, this configuration is
// consulted by native authentication before the signed owner claim handler.
// Unconfigured deploy secrets must not enable it with invented URL/cert bytes.
test('hosted signed owner bootstrap preserves absent optional integrations and refuses invalid or replayed claims', { timeout: 60000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 await buildFixture(root);
 const optedIn = randomBytes(24).toString('hex');
 const declarationFile = join(root, 'deploy.json');
 const declaration = JSON.parse(await readFile(declarationFile, 'utf8'));
 declaration.secrets.push(
  ...['WORKFORCE_SSO_ISSUER', 'WORKFORCE_SSO_URL', 'WORKFORCE_SSO_CERT'].map(binding => ({ binding, optional: true })),
  { binding: 'OPTIONAL_VERIFIER_VALUE', optional: true, verifyStandIn: optedIn },
 );
 await writeFile(declarationFile, JSON.stringify(declaration));
 await writeFile(join(root, 'dist/server/owner-entry.mjs'), `import worker from './index.js';
 export default {...worker, async fetch(request, env, context) {
  if (!env.SESSION_SECRET || env.OPTIONAL_VERIFIER_VALUE !== ${JSON.stringify(optedIn)}) return new Response('Missing declared verification binding', {status: 503});
  if (env.WORKFORCE_SSO_ISSUER && env.WORKFORCE_SSO_URL && env.WORKFORCE_SSO_CERT) {
   const endpoint = new URL(env.WORKFORCE_SSO_URL);
   if (endpoint.protocol !== 'https:') return new Response('Invalid identity endpoint', {status: 503});
  }
  return worker.fetch(request, env, context);
 }};`);
 const configFile = join(root, 'dist/server/wrangler.json');
 const config = JSON.parse(await readFile(configFile, 'utf8'));
 config.main = 'owner-entry.mjs';
 await writeFile(configFile, JSON.stringify(config));
 const result = await checkAgentDoor(root, { report() {} });
 assert.equal(result.ok, true);
 t.diagnostic(`Optional integration absent: ${result.points.length}/${result.points.length} hosted public-door points passed; explicit optional verifyStandIn retained.`);

 const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const forged = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const issuer = `https://issuer-${randomUUID()}.invalid`, installationId = randomUUID();
 const hosted = await serveHosted(root, { bindings: {
  OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: randomBytes(32).toString('hex'),
  RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId, RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
  RER_MANAGEMENT_ORIGIN: issuer, RER_INSTALLATION_ID: installationId,
  RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ fixture: await webcrypto.subtle.exportKey('jwk', pair.publicKey) }),
 } });
 try {
  const iat = seconds(), payload = { v: 1, iss: issuer, aud: hosted.origin, installationId, email: 'synthetic-base-1@example.com', jti: randomUUID(), iat, exp: iat + 300 };
  const claim = key => signJws(key, 'fixture', 'rer-owner-claim+jwt', payload);
  const post = token => hosted.fetch('auth/owner-claim', { method: 'POST', headers: { Origin: hosted.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, displayName: 'Owner' }) });
  const invalid = await post(await claim(forged.privateKey));
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error, 'invalid_claim');
  const db = await hosted.database('DB');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM oa_operators').first()).count, 0);
  const token = await claim(pair.privateKey), admitted = await post(token);
  assert.equal(admitted.status, 303);
  assert.ok(admitted.headers.getSetCookie().length);
  await admitted.body?.cancel();
  const replay = await post(token);
  assert.equal(replay.status, 409);
  await replay.body?.cancel();
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM oa_operators').first()).count, 1);
  t.diagnostic('Signed owner bootstrap: invalid signature HTTP 403 with no owner; valid claim HTTP 303 with session; replay HTTP 409 with one owner.');
 } finally { await hosted.close(); }
});
