import { approveSetupDependencies } from './dependency-approval.mjs';
import { appFetch } from './app-fetch.mjs';
import { createHmac } from 'node:crypto';
import {commandFailure,installationFailure} from './failures.mjs';
import { labels } from './adapter-labels.mjs';

// The CLI's own requests to its loopback server prove they come from the
// installation's owner-side tooling (modules/operator-auth/local-cli.mjs), so
// setup and dev restarts do not spend the owner's sign-in rate limit. A server
// that is not in local mode ignores the header. The proof comes from the
// setting the seed's adapter declares as its session secret (sessionSecretKey,
// default SESSION_SECRET).
export const localCliProof = secret => createHmac('sha256', secret).update('local-cli\0sign-in').digest('hex');
const post = (context, path, body) => {
 const secret = context.vars[context.sessionSecretKey ?? 'SESSION_SECRET'];
 return appFetch(new URL(path, context.origin), {
  method: 'POST', redirect: 'manual', signal: context.signal,
  headers: { Origin: context.origin, 'Content-Type': 'application/json', ...(typeof secret === 'string' && secret ? { 'x-rer-local-cli': localCliProof(secret) } : {}) }, body: JSON.stringify(body),
 });
};
const errorCode = async response => { try { const code = (await response.json())?.error; return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'no code'; } catch { return 'no code'; } };

// Claim the first owner through Base operator-auth POST /auth/bootstrap with
// the private setup token, or run the seed's own documented bootstrap. An
// already claimed installation keeps its owner.
export async function owner(context, hook) {
 const { store } = context;
 await store.step(labels.owner);
 await approveSetupDependencies(context, post);
 if(context.ownerClaim?.mode==='idp'){context.ownerClaimed='pending-idp';await store.step('The linked provider must grant the designated installation owner');return;}
 const { path = '/auth/bootstrap', tokenKey = context.ownerClaim?.tokenField ?? 'SETUP_TOKEN', displayName = input => input.displayName || input.name || 'Owner', returnTo = '/' } = hook;
 const token = context.vars[tokenKey];
 if (!token && hook.existingOwnerViaSignIn) { await store.step('Keeping the existing owner'); return; }
 if (!token) {
  throw authFailure(context,labels.owner,`${tokenKey} is missing from the private settings.`);
 }
 let response;
 try { response = await post(context, path, { token, displayName: displayName(context.input), returnTo }); } catch (error) {
  if (context.signal?.aborted) throw error;
  throw authFailure(context,labels.owner,'the application did not answer.');
 }
 if (response.status === 303) { await response.body?.cancel(); context.ownerClaimed = 'claimed'; await store.step('First owner claimed'); return; }
 const code = await errorCode(response);
 if (response.status === 409 && code === 'already_initialized') { context.ownerClaimed = 'kept'; await store.step('An owner is already claimed; the existing owner was kept'); return; }
 throw authFailure(context,labels.owner,`HTTP ${response.status} (${code}).`);
}

// Keep only the destination in installer state. The browser obtains its
// one-click dev identity through the authenticated /api/open-app response.
export async function signIn(context, hook) {
 if(context.ownerClaim?.mode==='idp' && context.ownerClaimed==='pending-idp')return;
 await context.store.step(labels.signIn);
 if (typeof hook === 'function') { context.appUrl = await hook(context); return; }
 context.appUrl = new URL(hook.returnTo ?? '/', context.origin).href;
}

function authFailure(context,label,reason){const message=context.store.redact?.(`${label}: ${reason}`)??`${label}: ${reason}`;context.store.report?.(message);return installationFailure('command_failed',{step:'setup',diagnostic:commandFailure(message)});}
