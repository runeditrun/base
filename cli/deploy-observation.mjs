// Observe the actual bootstrap exchange of a custom hook, including hooks that
// call the shared owner helper themselves. Never issue a second claim after it.
// The kit's deployment record, when the hook keeps one there, is checked before
// linking with its live setup token; rer checks the origin the hook returns too.
export async function observeOwner({ paths, inspect, beforeClaim, addSecret }, run) {
 const fetch = globalThis.fetch, claims = [];
 globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  let body;
  if (paths.includes(url.pathname) && (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST') {
   try { body = JSON.parse(typeof init.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : 'null'); } catch {}
  }
  if (typeof body?.token !== 'string' || !body.token) return fetch(input, init);
  addSecret(body.token);
  const deployed = await inspect();
  if (deployed && url.origin !== deployed.origin) throw new Error('owner-claim-origin-mismatch');
  await beforeClaim?.(body.token, url.origin);
  const response = await fetch(input, init);
  let code;
  if (response.status !== 303) {
   try { code = (await response.clone().json()).error; } catch {}
  }
  const outcome = response.status === 303 ? 'claimed' : response.status === 409 && code === 'already_initialized' ? 'kept' : undefined;
  claims.push({ origin: url.origin, outcome, status: response.status });
  return response;
 };
 try { return await run(claims); }
 finally { globalThis.fetch = fetch; }
}
