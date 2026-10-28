import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgentDoorConformance } from '../modules/agent-door/conformance/index.mjs';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';
import { seconds, signJws } from '../modules/agent-door/conformance/crypto.mjs';
import { readAgentSurface } from './agent-surface.mjs';
import { HOSTED_ORIGIN, serveHosted } from './hosted-output.mjs';
import { createAgentConformanceNetwork } from './agent-network.mjs';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

const defaultEmail = 'synthetic-base-1@example.com';
const ownerBindingValues = ['issuer', 'installationId', 'appOrigin', 'publicKeys', 'email', 'sub', 'token', 'sessionSecret'];

async function verificationOwner(root, value = {}) {
 if (!value || typeof value !== 'object' || Array.isArray(value)
  || Object.keys(value).some(key => !['email', 'emailField', 'tokenField', 'bindings', 'initializer'].includes(key))) throw new RerError('agent_owner_invalid', 'verification.owner must declare only email, emailField, tokenField, bindings and initializer.', 1);
 const email = value.email ?? defaultEmail;
 if (typeof email !== 'string' || email !== email.trim().toLowerCase() || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new RerError('agent_owner_invalid', 'verification.owner.email must be a canonical owner email.', 1);
 for (const key of ['emailField', 'tokenField']) if (value[key] !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(value[key])) throw new RerError('agent_owner_invalid', `verification.owner.${key} must name a production binding.`, 1);
 if (value.bindings !== undefined && (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)
  || Object.entries(value.bindings).some(([name, source]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !ownerBindingValues.includes(source)))) throw new RerError('agent_owner_invalid', `verification.owner.bindings must map native binding names to ${ownerBindingValues.join(', ')}.`, 1);
 let initialize;
 if (value.initializer !== undefined) {
  await contained(root, value.initializer);
  initialize = (await import(pathToFileURL(resolve(root, value.initializer)))).default;
  if (typeof initialize !== 'function') throw new RerError('agent_owner_invalid', 'verification.owner.initializer must default-export an async owner initializer.', 1);
 }
 return { ...value, email, initialize };
}

function finish(result, report) {
 for (const point of result.points) report(`${point.ok ? 'PASS' : 'FAIL'} ${point.id}${point.ok || !point.detail ? '' : `: ${point.detail}`}`);
 const failed = result.points.filter(point => !point.ok).map(point => point.id);
 report(`Agent door conformance: ${result.points.length - failed.length}/${result.points.length} points passed.`);
 if (!result.ok) throw new RerError('agent_door_failed', `Agent door conformance failed: ${failed.join(', ')}.`, 1, { failures: failed, agentDoor: result });
 return { declared: true, ...result };
}

/** A fresh production installation and key ring for every conformance run. */
export async function checkAgentDoor(root, { declaration, setupManifest, owner, report = console.log } = {}) {
 const declared = await readAgentSurface(root);
 if (!declared) { report('Agent door conformance: undeclared (no agent-surface.json).'); return { declared: false }; }
 const validation = validateAgentSurface(declared.surface, { contract: declared.contract });
 if (!validation.ok) return finish(validation, report);
 const manifest = setupManifest ?? JSON.parse(await readFile(join(root, 'rer-setup.json'), 'utf8'));
 const claim = manifest.steps?.find(step => step.type === 'owner-claim');
 const verification = declared.surface.verification ?? {};
 let prove;
 if (verification.proof !== undefined) {
  if (typeof verification.proof?.module !== 'string' || Object.keys(verification.proof).join(',') !== 'module') throw new RerError('agent_proof_invalid', 'verification.proof must name a contained test module.', 1);
  await contained(root, verification.proof.module);
  prove = (await import(pathToFileURL(resolve(root, verification.proof.module)))).default;
  if (typeof prove !== 'function') throw new RerError('agent_proof_invalid', 'verification.proof module must default-export a native proof test function.', 1);
 }
 const native = await verificationOwner(root, verification.owner), { email } = native;
 if (claim?.mode && !['signed', 'setup-token'].includes(claim.mode) && !native.initialize) throw new RerError('agent_owner_invalid', `Owner claim mode ${claim.mode} requires verification.owner.initializer using the seed's production lifecycle.`, 1);
 const token = randomBytes(32).toString('hex'), kid = randomUUID(), installationId = randomUUID(), sub = randomUUID();
 const business = 'rer-agent-conformance';
 const issuer = `https://synthetic-base-1-${randomUUID()}.invalid`;
 const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
 const publicKeys = { [kid]: { kty, crv, x, y, kid, alg: 'ES256', use: 'sig' } };
 const values = { issuer, installationId, appOrigin: HOSTED_ORIGIN, publicKeys: JSON.stringify(publicKeys), email, sub, token, sessionSecret: randomBytes(32).toString('hex') };
 const nativeBindings = Object.fromEntries(Object.entries(native.bindings ?? {}).map(([name, source]) => [name, values[source]]));
 const network = await createAgentConformanceNetwork(root, verification.network);
 let hosted;
 try {
 hosted = await serveHosted(root, { declaration, outboundService: network.fetch, bindings: {
  RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
  RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
  RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(publicKeys),
  RER_BUSINESS_TRUST: JSON.stringify({ v: 1, issuer, audience: HOSTED_ORIGIN, subject: installationId, email, keys: publicKeys }),
  OWNER_EMAIL: email, SETUP_TOKEN: token,
  ...(claim?.emailField ? { [claim.emailField]: email } : {}),
  ...(claim?.tokenField ? { [claim.tokenField]: token } : {}),
  ...(native.emailField ? { [native.emailField]: email } : {}),
  ...(native.tokenField ? { [native.tokenField]: token } : {}),
  ...nativeBindings,
 } });
  const request = (absolute, init = {}) => {
   const url = new URL(absolute);
   if (url.origin !== hosted.origin) throw new RerError('agent_door_origin', 'Agent conformance request must use the fresh hosted installation origin.', 1);
   const timeout = AbortSignal.timeout(30_000);
   return hosted.fetch(url.href.slice(hosted.origin.length + 1), { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, headers: Object.fromEntries(new Headers(init.headers)) });
  };
  const path = claim?.mode === 'signed' ? claim.path ?? '/auth/owner-claim' : owner?.path ?? claim?.path ?? '/auth/bootstrap';
  const issued = seconds();
  const claimToken = claim?.mode === 'signed' ? await signJws(pair.privateKey, kid, 'rer-owner-claim+jwt', {
   v: 1, iss: issuer, aud: hosted.origin, installationId, email, jti: randomUUID(), iat: issued, exp: issued + 300,
  }) : token;
  let bootstrap;
  try {
   bootstrap = native.initialize ? await native.initialize({ request, origin: hosted.origin, email, sub,
    displayName: 'Synthetic Base 1', token, claim: { mode: claim?.mode ?? 'setup-token', path, token: claimToken }, returnTo: owner?.returnTo ?? '/',
   }) : await request(new URL(path, hosted.origin).href, { method: 'POST', redirect: 'manual',
    headers: { Origin: hosted.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: claimToken, displayName: 'Synthetic Base 1', returnTo: owner?.returnTo ?? '/' }),
   });
  } catch {
   return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-001.owner-bootstrap', ok: false, detail: 'Native owner bootstrap did not answer through the hosted installation origin within 30 seconds.' }] }, report);
  }
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  await bootstrap.body?.cancel();
  if (bootstrap.status !== 303 || bootstrap.redirected || !cookie) return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-001.owner-bootstrap', ok: false, detail: `Native owner bootstrap returned HTTP ${bootstrap.status}${!cookie ? ' without a session cookie' : ''}.` }] }, report);
  const iat = seconds();
  const settings = await signJws(pair.privateKey, kid, 'rer-business-settings+jwt', {
   v: 1, iss: issuer, aud: hosted.origin, sub: installationId, business, email, owner_id: sub,
   jti: randomUUID(), iat, exp: iat + 300, rev: 1, values: {}, logo: null, team: null,
  });
  const paired = await request(new URL('/api/rer/business-settings', hosted.origin).href, {
   method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  let ack; try { ack = await paired.json(); } catch {}
  if (!paired.ok || ack?.rev !== 1) return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-004.business-owner-binding', ok: false, detail: `Signed Business owner binding returned HTTP ${paired.status} without the expected acknowledgement.` }] }, report);
  const result = await runAgentDoorConformance({ fetch: request, origin: hosted.origin, surface: declared.surface,
   signer: { issuer, installationId, kid, privateKey: pair.privateKey }, person: { email, cookie, sub }, business, prove,
  });
  return finish(result, report);
 } finally { try { await hosted?.close(); } finally { await network.close(); } }
}

if (process.argv[1] && await realpath(new URL(import.meta.url)) === await realpath(process.argv[1])) {
 try { await checkAgentDoor(resolve(process.argv[2] ?? '.'), { declaration: process.argv[3] }); }
 catch (error) { console.error(error instanceof RerError ? error.message : 'Agent door conformance could not complete.'); process.exitCode = 1; }
}
