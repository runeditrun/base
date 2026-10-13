import { randomBytes } from 'node:crypto';

// After a healthy deploy, the hosted app's first owner is the setup owner: rer
// claims it with the one-time setup token through the seed's standard owner step
// (Base operator-auth POST /auth/bootstrap), then removes that token from the
// Worker and records the new Worker version. A Worker still holding a token rer
// did not upload this run gets a fresh one first, unless the person supplied the
// token (environment or --env-file): that value is the deployed token and is used. A seed with its own owner step
// function, an identity-provider claim, or no declared token secret is left to it.
// `beforeClaim(token)` runs while the token is live (dependency approvals need it).
export async function claimHostedOwner({ hook, setupManifest, declaration, deployed, env, supplied = [], secret, addSecret, beforeClaim, fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), boundMs = 90000 }) {
 if (!hook || typeof hook !== 'object' || Array.isArray(hook) || !deployed.origin) return undefined;
 const claim = setupManifest?.steps?.find(step => step.type === 'owner-claim');
 if (claim?.mode === 'idp') return undefined;
 const tokenKey = hook.tokenKey ?? claim?.tokenField ?? 'SETUP_TOKEN';
 const item = (Array.isArray(declaration.secrets) ? declaration.secrets : []).find(entry => entry?.binding === tokenKey);
 if (!item || deployed.retiredSecrets?.includes(tokenKey)) return undefined;
 const given = env[item.environment]?.trim() && !supplied.includes(tokenKey);
 let token = deployed.sentSecrets?.includes(tokenKey) || given ? env[item.environment] : undefined;
 if (!token) {
  token = randomBytes(32).toString('hex'); addSecret(token);
  const { versionId } = await secret(['--set', tokenKey], { ...env, [item.environment]: token });
  // A secret change is a new Worker version; claim once the app answers from it.
  await servingVersion({ origin: deployed.origin, versionId, fetch, sleep, boundMs });
 }
 await beforeClaim?.(token);
 const displayName = (typeof hook.displayName === 'function' ? hook.displayName({}) : undefined) || 'Owner';
 let response, code;
 // Edge locations can briefly answer from the previous version, which lacks this token.
 for (let attempt = 1; ; attempt++) {
  try {
   response = await fetch(new URL(hook.path ?? '/auth/bootstrap', deployed.origin), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Origin: deployed.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, displayName, returnTo: hook.returnTo ?? '/' }) });
  } catch { throw ownerFailure('the hosted application did not answer'); }
  code = 'no code';
  if (response.status !== 303) { try { const body = await response.json(); if (typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)) code = body.error; } catch {} }
  else await response.body?.cancel();
  if (response.status !== 403 || code !== 'invalid_setup_token' || attempt === 3) break;
  await sleep(5000);
 }
 const outcome = response.status === 303 ? 'claimed' : response.status === 409 && code === 'already_initialized' ? 'kept' : undefined;
 if (!outcome) throw ownerFailure(`HTTP ${response.status} (${code})${code === 'invalid_setup_token' && given ? `; the ${item.environment} you supplied is not the deployed setup token: leave it unset and rer issues a fresh one` : ''}`);
 await secret(['--unset', tokenKey], env);
 return outcome;
}

async function servingVersion({ origin, versionId, fetch, sleep, boundMs }) {
 const deadline = Date.now() + boundMs;
 while (true) {
  try {
   const response = await fetch(new URL('/health', origin), { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' } });
   if ((await response.json().catch(() => null))?.deployment?.versionId === versionId) return;
  } catch {}
  if (Date.now() >= deadline) throw ownerFailure(`the hosted app did not answer from the Worker version holding the new setup token within ${Math.round(boundMs / 1000)} seconds`);
  await sleep(2000);
 }
}

function ownerFailure(cause) {
 const error = new Error('owner-claim-failed'); error.cause = cause; return error;
}
