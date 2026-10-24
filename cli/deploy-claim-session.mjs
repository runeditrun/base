// Nested deploy/hook observers can see the same response. Retire its credential
// once, after the hook has finished using it, and share any retirement failure.
const retirements = new WeakMap();
export function retireOwnerClaimSession(fetch, response, origin, signOutPath) {
 const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]);
 if (!cookies.length) return;
 if (!retirements.has(response)) retirements.set(response, signOut(fetch, origin, cookies.join('; '), signOutPath));
 return retirements.get(response);
}

async function signOut(fetch, origin, cookie, signOutPath) {
 const paths = signOutPath === undefined ? ['/auth/signout', '/api/auth/logout'] : [signOutPath];
 let response, path;
 const error = new Error('owner-claim-failed');
 error.ownerSessionRetirement = true;
 for (path of paths) {
  let url;
  try {
   url = new URL(path, origin);
   if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s?#]/.test(path) || url.origin !== origin || url.pathname !== path) throw error;
  } catch {
   error.cause = 'hooks.owner.signOutPath must be an absolute same-app path without a query or fragment; the unused owner session could not be retired';
   throw error;
  }
  try {
   response = await fetch(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
   });
   await response.body?.cancel();
   if (response.status === 204 && !response.redirected) return { retired: true };
   if (!response.redirected && [404, 405].includes(response.status)) continue;
  } catch { response = undefined; }
  break;
 }
 error.cause = `POST ${path} ${response ? `returned HTTP ${response.status}` : 'did not answer'}; the unused owner session could not be retired`;
 throw error;
}
