import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAgentDoorConformance } from '../modules/agent-door/conformance/index.mjs';
import { validateAgentSurface } from '../modules/agent-door/conformance/surface.mjs';
import { readAgentSurface } from './agent-surface.mjs';
import { HOSTED_ORIGIN, serveHosted } from './hosted-output.mjs';
import { agentConformanceNetwork } from './agent-network.mjs';
import { RerError } from './errors.mjs';

const email = 'synthetic-base-1@example.com';

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
 const token = randomBytes(32).toString('hex'), kid = randomUUID(), installationId = randomUUID();
 const issuer = `https://synthetic-base-1-${randomUUID()}.invalid`;
 const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
 const hosted = await serveHosted(root, { declaration, outboundService: agentConformanceNetwork, bindings: {
  RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
  RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
  RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ [kid]: { kty, crv, x, y, kid, alg: 'ES256', use: 'sig' } }),
  OWNER_EMAIL: email, SETUP_TOKEN: token,
  ...(claim?.emailField ? { [claim.emailField]: email } : {}),
  ...(claim?.tokenField ? { [claim.tokenField]: token } : {}),
 } });
 try {
  const request = (absolute, init = {}) => {
   const url = new URL(absolute);
   if (url.origin !== hosted.origin) throw new RerError('agent_door_origin', 'Agent conformance request must use the fresh hosted installation origin.', 1);
   const timeout = AbortSignal.timeout(30_000);
   return hosted.fetch(url.href.slice(hosted.origin.length + 1), { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, headers: Object.fromEntries(new Headers(init.headers)) });
  };
  const path = owner?.path ?? claim?.path ?? '/auth/bootstrap';
  let bootstrap;
  try {
   bootstrap = await request(new URL(path, hosted.origin).href, { method: 'POST', redirect: 'manual',
    headers: { Origin: hosted.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, displayName: 'Synthetic Base 1', returnTo: owner?.returnTo ?? '/' }),
   });
  } catch {
   return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-001.owner-bootstrap', ok: false, detail: 'Native owner bootstrap did not answer through the hosted installation origin within 30 seconds.' }] }, report);
  }
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  await bootstrap.body?.cancel();
  if (bootstrap.status !== 303 || bootstrap.redirected || !cookie) return finish({ ok: false, points: [...validation.points, { id: 'BASE-AGENT-001.owner-bootstrap', ok: false, detail: `Native owner bootstrap returned HTTP ${bootstrap.status}${!cookie ? ' without a session cookie' : ''}.` }] }, report);
  const result = await runAgentDoorConformance({ fetch: request, origin: hosted.origin, surface: declared.surface,
   signer: { issuer, installationId, kid, privateKey: pair.privateKey }, person: { email, cookie },
  });
  return finish(result, report);
 } finally { await hosted.close(); }
}

if (process.argv[1] && await realpath(new URL(import.meta.url)) === await realpath(process.argv[1])) {
 try { await checkAgentDoor(resolve(process.argv[2] ?? '.'), { declaration: process.argv[3] }); }
 catch (error) { console.error(error instanceof RerError ? error.message : 'Agent door conformance could not complete.'); process.exitCode = 1; }
}
