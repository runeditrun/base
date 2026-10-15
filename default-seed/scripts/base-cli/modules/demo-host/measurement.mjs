import { equalSecret } from './operator.mjs';

// A test host runs on one of Cloudflare's Turnstile testing secrets, which pass
// (or fail) every visitor alike, so automated browsers took real places within
// minutes of a new certificate (gr-base-164). There a start must carry the
// deploy's measurement token, which `rer deploy --demo` prints to the operator:
// the cookie rer_demo_measure or the header x-rer-demo-measurement. A host with
// a real Turnstile secret never asks for it.
export const TESTING_SECRET = /^[123]x0{31}AA$/;
export const MEASUREMENT_COOKIE = 'rer_demo_measure', MEASUREMENT_HEADER = 'x-rer-demo-measurement';

export const testHost = env => TESTING_SECRET.test(env.TURNSTILE_SECRET_KEY ?? '');

/** Whether a start on a test host carries this deploy's token; a test host without one admits nobody. */
export async function measured(request, env) {
  const cookie = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${MEASUREMENT_COOKIE}=`))?.slice(MEASUREMENT_COOKIE.length + 1);
  return equalSecret(env.RER_DEMO_MEASUREMENT_TOKEN, request.headers.get(MEASUREMENT_HEADER) ?? cookie);
}
