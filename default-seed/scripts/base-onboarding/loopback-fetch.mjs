import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const portable = basename(dirname(fileURLToPath(import.meta.url))) === 'base-onboarding';
const { isLoopbackHost } = await import(new URL(portable ? '../base-cli/modules/operator-auth/loopback.mjs' : '../modules/operator-auth/loopback.mjs', import.meta.url));

// Local harness servers may close idle sockets between readiness and a claim.
// Close each exchange instead of pooling a socket that can already be closed;
// never retry a request, particularly a POST with effects.
export function loopbackFetch(input, init = {}) {
 const url = new URL(input instanceof Request ? input.url : String(input));
 if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) return fetch(input, init);
 const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
 headers.set('connection', 'close');
 return fetch(input, { ...init, headers });
}
