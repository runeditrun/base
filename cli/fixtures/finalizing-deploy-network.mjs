import { ownerProvider } from '../../modules/deploy-kit/tests/owner-provider.mjs';

// Only the provider and hosted HTTP edge are fake. The dispatcher, hook, owner
// claim, token retirement and finalization run in the real CLI child process.
const provider = ownerProvider();
let elapsed = 0, finalizing = false, probes = 0, claims = 0, claimRoutes = 0;
performance.now = () => elapsed;
process.once('exit', () => provider.close());
export function hookReturned() { elapsed += 90000; finalizing = true; }

globalThis.fetch = async (input, init = {}) => {
 const url = new URL(input);
 if (url.pathname === '/auth/bootstrap') {
  const token = JSON.parse(init.body).token;
  if (token !== provider.state.secrets.find(item => item.name === 'SETUP_TOKEN')?.value) return Response.json({ error: 'invalid_setup_token' }, { status: 403 });
  if (++claimRoutes === 1) return new Response('error code: 1042', {status:404});
  if (++claims !== 1) throw Error('The first deploy must claim only once');
  // RER_TEST_SIGNOUT makes bootstrap issue a session requiring revocation.
  return new Response(null, { status: 303, headers: process.env.RER_TEST_SIGNOUT ? { 'set-cookie': 'session=test-only; HttpOnly' } : {} });
 }
 if (url.pathname === process.env.RER_TEST_SIGNOUT_PATH) {
  if (new Headers(init.headers).get('cookie') !== 'session=test-only') throw Error('Missing claim session');
  return new Response(null, {status:204});
 }
 if (['/auth/signout', '/api/auth/logout'].includes(url.pathname) && process.env.RER_TEST_SIGNOUT) return new Response(null, { status: Number(process.env.RER_TEST_SIGNOUT) });
 if (url.pathname === '/api/identity/setup-status') return Response.json({ setupRequired: false });
 if (finalizing && url.pathname === '/health') {
  probes++; elapsed += 10000;
  if (claims !== 1 || provider.state.secrets.some(item => item.name === 'SETUP_TOKEN')) throw Error('Hook did not finish owner claim and token retirement');
  if (probes === 1) throw new TypeError('test-only edge not answering yet');
  const wrong = process.env.RER_TEST_FINAL_HEALTH === 'wrong';
  if (wrong && probes > 2) elapsed += 90000;
  if (wrong || probes === 2) return Response.json({ ok: true, deployment: { sourceSha: wrong && probes === 2 ? 'abcdef0123456789abcdef0123456789abcdef01' : '0123456789abcdef0123456789abcdef01234567', versionId: wrong ? provider.state.version.id : 'previous-edge-version' } });
 }
 return provider.fetch(input, init);
};
