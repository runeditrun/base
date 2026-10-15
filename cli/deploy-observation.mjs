import { observeReadiness, observedReadiness } from '../modules/deploy-kit/readiness-window.mjs';
import { ownerClaimRequest } from './deploy-claim-request.mjs';
// Observe the actual bootstrap exchange of a custom hook, including hooks that
// call the shared owner helper themselves. Never issue a second claim after it.
// The kit's deployment record, when the hook keeps one there, is checked before
// linking with its live setup token; rer checks the origin the hook returns too.
export async function observeOwner({ paths, inspect, beforeClaim, addSecret, deployed: knownDeployment, tokenKey }, run) {
 const fetch = globalThis.fetch, claims = [];
 globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  let body;
  if (paths.includes(url.pathname) && (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST') {
   try { body = JSON.parse(typeof init.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : 'null'); } catch {}
  }
  if (typeof body?.token !== 'string' || !body.token) {
   const response = await fetch(input,init);
   if (claims.some(item => item.origin === url.origin)) claims.lastExchange = await exchange(response,url,init.method ?? 'GET');
   return response;
  }
  addSecret(body.token);
  const deployed = await inspect(url.origin);
  if (deployed && url.origin !== deployed.origin) throw new Error('owner-claim-origin-mismatch');
  await beforeClaim?.(body.token, url.origin);
  const known = knownDeployment?.() ?? observedReadiness(url.origin);
  const response = await ownerClaimRequest(fetch, input, init, {deployed:known ?? deployed, tokenKey});
  let code;
  if (response.status !== 303) {
   try { code = (await response.clone().json()).error; } catch {}
  }
  const outcome = response.status === 303 ? 'claimed' : response.status === 409 && code === 'already_initialized' ? 'kept' : undefined;
  const observed = {...await exchange(response,url,'POST'),outcome};
  claims.push(observed); claims.lastExchange = observed;
  return response;
 };
 try { return await observeReadiness(() => run(claims)); }
 finally { globalThis.fetch = fetch; }
}

async function exchange(response,url,method) {
 let code;
 if (response.status >= 400) { try { code = (await response.clone().json()).error; } catch {} }
 return {origin:url.origin,path:url.pathname,method,status:response.status,
  ...(typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? {code} : {}),
  ...(response.status === 303 && !response.headers.has('set-cookie') ? {missingCookie:true} : {})};
}

export function ownerExchangeFailure(exchange) {
 if (!exchange || typeof exchange.path !== 'string' || !Number.isInteger(exchange.status)) return undefined;
 return `${exchange.method === 'GET' ? 'GET' : 'POST'} ${exchange.path.split('?')[0]} returned HTTP ${exchange.status}${exchange.code ? ` (${exchange.code})` : ''}${exchange.missingCookie ? ' (no Set-Cookie header)' : ''}`;
}
