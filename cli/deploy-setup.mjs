// Some native apps expose setup status without registering a shared owner step.
// An explicit unfinished setup must not become deploy success just because
// /health is healthy. An absent or unsupported endpoint proves nothing either
// way and remains compatible with apps that do not implement this optional API.
export async function checkHostedSetup({ origin, claimed, signal }) {
 if (['claimed', 'kept'].includes(claimed)) return;
 let required = false;
 try {
  const response = await globalThis.fetch(new URL('/api/identity/setup-status', origin), {
   method: 'GET', credentials: 'omit', redirect: 'manual',
   headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
   signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  // Never follow a redirect or interpret an error page as a setup contract.
  if (!response.redirected && (response.ok || response.status === 409)) required = (await response.json())?.setupRequired === true;
  else await response.body?.cancel();
 } catch { /* Only an explicit setup-required response establishes this gap. */ }
 signal?.throwIfAborted();
 if (required) throw new Error('hosted-setup-required');
}

export function hostedSetupFailure(error, { origin, again }) {
 if (error.message !== 'hosted-setup-required') return undefined;
 return `Deploy is incomplete. The application is deployed at ${origin}, but /api/identity/setup-status reports that setup is required and the owner claim is not confirmed. The deployed resources are retained for recovery. Fix or register the application's actual native owner-claim integration in its adapter and setup manifest, then rerun ${again} using the same environment credentials.`;
}
