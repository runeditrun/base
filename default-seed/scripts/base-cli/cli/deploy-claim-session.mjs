// Nested deploy/hook observers can see the same response. Retire its credential
// once, after the hook has finished using it, and share any retirement failure.
const retirements = new WeakMap();
export function retireOwnerClaimSession(fetch, response, origin) {
 const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]);
 if (!cookies.length) return;
 if (!retirements.has(response)) retirements.set(response, signOut(fetch, origin, cookies.join('; ')));
 return retirements.get(response);
}

async function signOut(fetch, origin, cookie) {
 let response;
 try {
  response = await fetch(new URL('/auth/signout', origin), {
   method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
   headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
  });
  await response.body?.cancel();
  if (response.status === 204 && !response.redirected) return;
 } catch {}
 const error = new Error('owner-claim-failed');
 error.ownerSessionRetirement = true;
 error.cause = `POST /auth/signout ${response ? `returned HTTP ${response.status}` : 'did not answer'}; the unused owner session could not be retired`;
 throw error;
}
