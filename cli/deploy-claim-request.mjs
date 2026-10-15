import { observedReadiness } from '../modules/deploy-kit/readiness-window.mjs';
// Retry only the bootstrap HTTP exchange, never the hook's other effects. The
// current invocation must prove it uploaded this token to a newly created Worker.
export async function ownerClaimRequest(fetch, input, init, { deployed, tokenKey = 'SETUP_TOKEN', signal } = {}) {
 const url = new URL(input instanceof Request ? input.url : input);
 if (deployed?.origin && url.origin !== deployed.origin) throw new Error('owner-claim-origin-mismatch');
 const known = deployed?.propagation ? deployed : observedReadiness(url.origin);
 const propagation = known?.propagation;
 let token;
 try { token = JSON.parse(typeof init.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : 'null')?.token; } catch {}
 const fresh = propagation?.freshUpload && propagation.versionId === (deployed?.versionId ?? known.versionId) && propagation.matchesToken(tokenKey, token);
 const window = fresh ? propagation.window : undefined;
 for (;;) {
  const remaining = window?.remaining() ?? 30000;
  if (remaining <= 0) throw new Error('owner-claim-readiness-timeout');
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(30000, remaining))));
  const signals = [signal, init.signal, input instanceof Request ? input.signal : undefined, timeout].filter(Boolean);
  const response = await fetch(input instanceof Request ? input.clone() : input, { ...init, redirect: 'manual', signal: AbortSignal.any(signals) });
  if (response.redirected) throw new Error('owner-claim-redirected');
  if (response.status === 303) {
   const destination = response.headers.get('location');
   if (destination && new URL(destination, url).origin !== url.origin) throw new Error('owner-claim-origin-mismatch');
  }
  let invalid = false;
  if (fresh && response.status === 403) {
   try { invalid = (await response.clone().json())?.error === 'invalid_setup_token'; } catch {}
  }
  if (!invalid || window.remaining() <= 0) return response;
  await response.body?.cancel();
  await window.pause();
 }
}
