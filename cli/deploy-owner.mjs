import { ownerClaimRequest } from './deploy-claim-request.mjs';
import { retireOwnerClaimSession, unretiredNotice } from './deploy-claim-session.mjs';
import { observeOwner, ownerExchangeFailure } from './deploy-observation.mjs';
import { randomBytes } from 'node:crypto';

// After a healthy deploy, the hosted app's first owner is the setup owner: rer
// claims it with the one-time setup token through the seed's standard owner step
// (Base operator-auth POST /auth/bootstrap), signs out its unused session, then
// removes that token from the Worker and records the new Worker version. A Worker still holding a token rer
// did not upload this run gets a fresh one first, unless the person supplied the
// token (environment or --env-file) and inspection has not found it absent. A
// seed with its own owner step function runs its own bootstrap; identity-provider
// linking runs before retirement. Without `secret`, the Worker's secrets are a
// deploy hook's own: rer claims with the `token` it returned, else the one rer
// gave it, and leaves that token with the hook.
// `beforeClaim(token)` runs while the token is live (dependency approvals need it).
export async function claimHostedOwner({ hook, setupManifest, declaration, deployed, env, input = {}, displayName, supplied = [], secret, token: hookToken, addSecret, beforeClaim, recordClaim, inspect, store, signal, fetch = globalThis.fetch }) {
 const claim = setupManifest?.steps?.find(step => step.type === 'owner-claim');
 if (!hook || !['object', 'function'].includes(typeof hook) || Array.isArray(hook) || !deployed.origin) {
  if (declaration.secrets?.some(item => item.binding === (claim?.tokenField ?? 'SETUP_TOKEN'))) throw ownerFailure('the owner bootstrap hook is unavailable');
  return undefined;
 }
 const tokenKey = hook.tokenKey ?? claim?.tokenField ?? 'SETUP_TOKEN';
 const item = (Array.isArray(declaration.secrets) ? declaration.secrets : []).find(entry => entry?.binding === tokenKey);
 if (!item) { if (claim) throw ownerFailure('the deploy declaration does not name the owner setup token secret'); return undefined; }
 const retire = async outcome => {
  if (!secret) return outcome;
  // A recorded claim stays as recorded: a later deploy keeps that owner.
  try { if (!deployed.ownerClaim) await recordClaim?.(outcome); await secret(['--unset', tokenKey], env); }
  catch (cause) {
   if (cause.secretChange) { cause.owner = outcome; cause.tokenKey = tokenKey; cause.ownerFinalization = true; throw cause; }
   const error = new Error('owner-token-retirement-failed'); error.owner = outcome; error.tokenKey = tokenKey; error.cause = cause; throw error; }
  return outcome;
 };
 // Only a recorded successful bootstrap proves ownership; --unset-secret alone
 // can retire a token while the application is still unclaimed. A legacy hook
 // can re-upload a spent token, so always remove it again after ownership proof.
 if (deployed.owner || deployed.ownerClaim) { await beforeClaim?.(); return retire(deployed.owner ?? 'kept'); }
 // Older direct callers only recorded token retirement, without an ownership
 // record or live-secret inspection. Keep their completed deploys idempotent.
 if (!deployed.liveSecrets && deployed.retiredSecrets?.includes(tokenKey)) return undefined;
 const given = (!deployed.liveSecrets || deployed.liveSecrets.includes(tokenKey)) && env[item.environment]?.trim() && !supplied.includes(tokenKey);
 let token = !secret ? hookToken ?? env[item.environment] : deployed.sentSecrets?.includes(tokenKey) || given ? env[item.environment] : undefined;
 if (!token && !secret) throw ownerFailure(`the deploy hook returned no setupToken and ${item.environment} is not set`);
 if (!token) {
  token = randomBytes(32).toString('hex'); addSecret(token);
  // The secret controller confirms readiness of the full new version identity.
  await secret(['--set', tokenKey], { ...env, [item.environment]: token });
 }
 const linked = await beforeClaim?.(token);
 if (claim?.mode === 'idp') {
  if (!linked?.ownerClaimed || !['claimed', 'kept'].includes(linked.ownerOutcome)) throw ownerFailure('the identity provider has not confirmed the designated owner link');
  return retire(linked.ownerOutcome);
 }
 if (typeof hook === 'function') {
  const context = { origin: deployed.origin, vars: { ...env, [tokenKey]: token }, input, store, signal, ownerClaim: claim, fail: () => ownerFailure('the seed owner hook failed') };
  let observed, exchanges = [];
  try {
   if (deployed.observedOwner) await hook(context);
   else await observeOwner({ paths: ['/auth/bootstrap', claim?.path].filter(Boolean), inspect, addSecret, deployed: () => deployed, tokenKey, report: line => store?.report?.(line) }, async claims => { exchanges = claims; await hook(context); observed = claims.at(-1)?.outcome; });
  } catch (cause) {
   const exchange = exchanges.lastExchange ?? exchanges.at(-1);
   const error = cause.message === 'owner-claim-failed' ? cause : ownerFailure(cause.message);
   if (exchange && !cause.ownerSessionRetirement) { error.ownerExchange = exchange; error.cause = ownerExchangeFailure(exchange); }
   throw error;
  }
  // Function hooks can keep existing owners without returning a value. Observe
  // their actual response, instead of assuming that a resolved promise claimed.
  const outcome = context.ownerClaimed ?? observed ?? deployed.observedOwner?.();
  if (!['claimed', 'kept'].includes(outcome)) throw ownerFailure('the seed owner hook did not confirm its bootstrap exchange');
  return retire(outcome);
 }
 displayName = (typeof hook.displayName === 'function' ? hook.displayName(input) : undefined) || displayName || 'Owner';
 let response, code = 'no code';
 try {
  response = await ownerClaimRequest(fetch, new URL(hook.path ?? '/auth/bootstrap', deployed.origin), { method: 'POST',
   headers: { Origin: deployed.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, displayName, returnTo: hook.returnTo ?? '/' }) }, {deployed, tokenKey, signal});
 } catch (error) { throw ownerFailure(`POST ${new URL(hook.path ?? '/auth/bootstrap',deployed.origin).pathname}: ` + (['owner-claim-origin-mismatch','owner-claim-redirected','owner-claim-readiness-timeout'].includes(error.message) ? error.message : 'the hosted application did not answer')); }
 if (response.status !== 303) { try { const body = await response.json(); if (typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)) code = body.error; } catch {} }
 else { const retired = await retireOwnerClaimSession(fetch, response, deployed.origin); if (retired?.retired === false) store?.report?.(unretiredNotice(retired)); await response.body?.cancel(); }
 const outcome = response.status === 303 ? 'claimed' : response.status === 409 && code === 'already_initialized' ? 'kept' : undefined;
 const advice = code !== 'invalid_setup_token' ? '' : !secret ? `; the Worker holds another setup token: have the deploy hook return the one it deployed as setupToken, or set it as ${item.environment} with --env-file` : given ? `; the ${item.environment} you supplied is not the deployed setup token: leave it unset and rer issues a fresh one` : '';
 if (!outcome) throw ownerFailure(`POST ${new URL(hook.path ?? '/auth/bootstrap',deployed.origin).pathname} returned HTTP ${response.status} (${code})${advice}`);
 return retire(outcome);
}

function ownerFailure(cause) {
 const error = new Error('owner-claim-failed'); error.cause = cause; return error;
}
