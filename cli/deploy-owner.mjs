import { observeOwner } from './deploy-observation.mjs';
import { randomBytes } from 'node:crypto';

// After a healthy deploy, the hosted app's first owner is the setup owner: rer
// claims it with the one-time setup token through the seed's standard owner step
// (Base operator-auth POST /auth/bootstrap), then removes that token from the
// Worker and records the new Worker version. A Worker still holding a token rer
// did not upload this run gets a fresh one first, unless the person supplied the
// token (environment or --env-file): that value is the deployed token and is used. A seed with its own owner step
// function runs its own bootstrap; identity-provider linking runs before retirement.
// `beforeClaim(token)` runs while the token is live (dependency approvals need it).
export async function claimHostedOwner({ hook, setupManifest, declaration, deployed, env, supplied = [], secret, addSecret, beforeClaim, recordClaim, inspect, store, signal, fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), boundMs = 90000 }) {
 const claim = setupManifest?.steps?.find(step => step.type === 'owner-claim');
 if (!hook || !['object', 'function'].includes(typeof hook) || Array.isArray(hook) || !deployed.origin) {
  if (declaration.secrets?.some(item => item.binding === (claim?.tokenField ?? 'SETUP_TOKEN'))) throw ownerFailure('the owner bootstrap hook is unavailable');
  return undefined;
 }
 const tokenKey = hook.tokenKey ?? claim?.tokenField ?? 'SETUP_TOKEN';
 const item = (Array.isArray(declaration.secrets) ? declaration.secrets : []).find(entry => entry?.binding === tokenKey);
 if (!item) { if (claim) throw ownerFailure('the deploy declaration does not name the owner setup token secret'); return undefined; }
 const retire = async outcome => {
  try { await recordClaim(outcome); await secret(['--unset', tokenKey], env); }
  catch (cause) { const error = new Error('owner-token-retirement-failed'); error.owner = outcome; error.tokenKey = tokenKey; error.cause = cause.message; throw error; }
  return outcome;
 };
 // Only a recorded successful bootstrap proves ownership; --unset-secret alone
 // can retire a token while the application is still unclaimed. A legacy hook
 // can re-upload a spent token, so always remove it again after ownership proof.
 if (deployed.owner || deployed.ownerClaim) { await beforeClaim?.(); return retire(deployed.owner ?? 'kept'); }
 const given = !deployed.liveSecrets && env[item.environment]?.trim() && !supplied.includes(tokenKey);
 let token = deployed.sentSecrets?.includes(tokenKey) || given ? env[item.environment] : undefined;
 if (!token) {
  token = randomBytes(32).toString('hex'); addSecret(token);
  const { versionId } = await secret(['--set', tokenKey], { ...env, [item.environment]: token });
  // A secret change is a new Worker version; claim once the app answers from it.
  await servingVersion({ origin: deployed.origin, versionId, fetch, sleep, boundMs });
 }
 const linked = await beforeClaim?.(token);
 if (claim?.mode === 'idp') {
  if (!linked?.ownerClaimed || !['claimed', 'kept'].includes(linked.ownerOutcome)) throw ownerFailure('the identity provider has not confirmed the designated owner link');
  return retire(linked.ownerOutcome);
 }
 if (typeof hook === 'function') {
  const context = { origin: deployed.origin, vars: { ...env, [tokenKey]: token }, input: {}, store, signal, ownerClaim: claim, fail: () => ownerFailure('the seed owner hook failed') };
  let observed;
  try {
   if (deployed.observedOwner) await hook(context);
   else await observeOwner({ paths: ['/auth/bootstrap', claim?.path].filter(Boolean), inspect, addSecret }, async claims => { await hook(context); observed = claims.at(-1)?.outcome; });
  } catch (cause) { if (cause.message === 'owner-claim-failed') throw cause; throw ownerFailure(cause.message); }
  // Function hooks can keep existing owners without returning a value. Observe
  // their actual response, instead of assuming that a resolved promise claimed.
  const outcome = context.ownerClaimed ?? observed ?? deployed.observedOwner?.();
  if (!['claimed', 'kept'].includes(outcome)) throw ownerFailure('the seed owner hook did not confirm its bootstrap exchange');
  return retire(outcome);
 }
 const displayName = (typeof hook.displayName === 'function' ? hook.displayName({}) : undefined) || 'Owner';
 let response, code = 'no code';
 try {
  response = await fetch(new URL(hook.path ?? '/auth/bootstrap', deployed.origin), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
   headers: { Origin: deployed.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, displayName, returnTo: hook.returnTo ?? '/' }) });
 } catch { throw ownerFailure('the hosted application did not answer'); }
 if (response.status !== 303) { try { const body = await response.json(); if (typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)) code = body.error; } catch {} }
 else await response.body?.cancel();
 const outcome = response.status === 303 ? 'claimed' : response.status === 409 && code === 'already_initialized' ? 'kept' : undefined;
 if (!outcome) throw ownerFailure(`HTTP ${response.status} (${code})${code === 'invalid_setup_token' && given ? `; the ${item.environment} you supplied is not the deployed setup token: leave it unset and rer issues a fresh one` : ''}`);
 return retire(outcome);
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
