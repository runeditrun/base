import { waitHealth } from '../modules/deploy-kit/health-request.mjs';
import { isLoopbackHost } from '../modules/operator-auth/loopback.mjs';

// A custom deploy hook owns its upload and whatever record it keeps of it. It
// returns { deployed: true, origin }; rer claims the owner only once that
// origin's /health names the commit this run deployed. The origin is https
// (http only on loopback), since the claim sends the one-time setup token there.
export function hookOrigin(deployed, again) {
 const url = deployed?.deployed === true && typeof deployed.origin === 'string' && URL.canParse(deployed.origin) ? new URL(deployed.origin) : undefined;
 if (url?.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw hookFailure(`The deploy hook reported its deployment at ${url.origin}, which is not https, so rer sent it nothing and claimed no owner. Make the hook return its https origin, then run ${again} again.`);
 if (url && (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === deployed.origin) return url.origin;
 throw hookFailure(`The deploy hook finished without reporting a live deployment, so rer claimed no owner. A deploy hook returns { deployed: true, origin } once its upload is live. Check the hook's output above, fix the hook, then run ${again} again.`);
}

export async function waitForSource({ origin, sourceSha, again }) {
 try { await waitHealth({ origin, expected: { sourceSha }, request: (url, init) => globalThis.fetch(url, init) }); }
 catch (error) {
  const last = error.attempts?.at(-1);
  let named;
  try { named = JSON.parse(last.body).deployment?.sourceSha; } catch {}
  const seen = !last || last.status === null ? 'it did not answer'
   : last.status !== 200 ? `its last answer was HTTP ${last.status}`
   : typeof named === 'string' && /^[0-9a-f]{7,64}$/.test(named) ? `it still answers for commit ${named.slice(0, 12)}`
   : 'it answers without a deploy identity';
  throw hookFailure(`The deploy hook reported a deployment at ${origin}, but its /health never named this checkout's commit ${sourceSha.slice(0, 12)} (${seen}), so rer claimed no owner. Check that the hook uploaded this build and that /health answers deploymentHealth(env), then run ${again} again.`);
 }
}

function hookFailure(message) {
 return Object.assign(new Error(message), { hookFailure: true });
}
