// Nested deploy/hook observers can see the same response. Retire its credential
// once, after the hook has finished using it, and share any retirement failure.
// An app that serves no sign-out at Base's route (Slate signs out at its own
// /api/auth/logout and answers 404 here; 405 is the same answer) cannot have
// the session retired there: the result says so ({ retired: false, status })
// and the deploy goes on to remove the setup token, since the session's cookie
// existed only in this process. A sign-out the app refuses (any other status)
// or never answers still fails the claim.
const retirements = new WeakMap();
export const unretiredNotice = ({ status }) => `The hosted app answered HTTP ${status} to POST /auth/signout, Base's sign-out route, so rer could not sign out the owner session its claim opened. Nothing else holds that session: its cookie existed only inside this rer process, which has dropped it. The owner is claimed.`;
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
  if (response.status === 204 && !response.redirected) return { retired: true };
  if ([404, 405].includes(response.status) && !response.redirected) return { retired: false, status: response.status };
 } catch {}
 const error = new Error('owner-claim-failed');
 error.ownerSessionRetirement = true;
 error.cause = `POST /auth/signout ${response ? `returned HTTP ${response.status}` : 'did not answer'}; the unused owner session could not be retired`;
 throw error;
}
