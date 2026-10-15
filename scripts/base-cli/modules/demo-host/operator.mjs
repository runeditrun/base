import { startPage } from './pages.mjs';

// This credential belongs to the demo HOST operator, never a demo's signed-in
// owner. It is supplied only as an Authorization header, never a URL/cookie.
export async function operatorPage(request, env, correlation) {
  const expected = env.RER_DEMO_OPERATOR_TOKEN;
  const authorization = request.headers.get('authorization') ?? '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!expected || expected.length < 32 || !supplied || supplied.length > 512) return new Response('Unauthorized', { status: 401 });
  const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(expected), digest(supplied)]);
  let unequal = 0; const av = new Uint8Array(a), bv = new Uint8Array(b);
  for (let i = 0; i < av.length; i++) unequal |= av[i] ^ bv[i];
  if (unequal) return new Response('Unauthorized', { status: 401 });
  const record = await env.CAPACITY.get(env.CAPACITY.idFromName('diagnostics')).diagnostic(correlation);
  return startPage(env, { status: record ? 200 : 404, notice: record ? `Operator diagnostic: ${JSON.stringify(record)}` : 'No retained diagnostic for this start.' });
}
