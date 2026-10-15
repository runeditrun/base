import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { verifyOwnerClaim } from '../../owner-claim/verify.mjs';
import { DEMO_FILES } from '../plan.mjs';

// The hosted demo's front Worker through its public door, in workerd with its
// real Durable Objects and rate limit. Fakes stand only at the paid and
// network edges: Turnstile's siteverify, and the container platform, whose
// "containers" are this app. The app checks the front's owner claim with
// owner-claim's real verifier, as the seed does.
export const ORIGIN = 'https://demo.run-test.example';

export async function front({ max = 10, idle, evictMs, health, startMs, probeMs, destroyFailures = 0, cleanupMs, siteKey = 'site-key', siteverify, placementFailures = 0, name = 'Test' } = {}) {
  const demos = new Map();
  async function app(request) {
    const url = new URL(request.url), id = request.headers.get('x-demo');
    if (url.hostname === 'platform') {
      if (url.pathname === '/start') demos.set(id, { ...await request.json(), destroyed: false, requests: [] });
      else if (url.pathname === '/stopped') demos.get(id).evicted = true;
      else { if (destroyFailures-- > 0) return new Response(null, { status: 503 }); demos.get(id).destroyed = true; }
      return new Response(null, { status: 204 });
    }
    const demo = demos.get(id);
    if (!demo || demo.destroyed) return new Response('no container', { status: 502 });
    if (demo.stop) return new Response(null, { status: 598 });
    demo.requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/health') return health ? health(demo) : Response.json({ ok: true });
    if (url.pathname === '/auth/owner-claim') {
      const { env } = demo;
      if (request.method !== 'POST' || request.headers.get('origin') !== env.AUTH_ORIGIN) return new Response(null, { status: 403 });
      try {
        await verifyOwnerClaim(new URLSearchParams(await request.text()).get('token'), { issuer: env.RER_OWNER_CLAIM_ISSUER, installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID,
          appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) });
      } catch { return new Response(null, { status: 403 }); }
      return new Response(null, { status: 303, headers: { location: '/app', 'set-cookie': `__Host-operator_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax` } });
    }
    return new Response(`${id} ${url.pathname}`);
  }
  const verified = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: fileURLToPath(new URL('..', import.meta.url)), modules: ['tests/fixture.mjs', ...DEMO_FILES].map(path => ({ type: 'ESModule', path: fileURLToPath(new URL(`../${path}`, import.meta.url)) })), compatibilityDate: '2026-09-08',
    durableObjects: { DEMO: { className: 'DemoContainer', useSQLite: true }, CAPACITY: { className: 'DemoCapacity', useSQLite: true } },
    ratelimits: { STARTS: { namespace_id: '1001', simple: { limit: 3, period: 60 } } },
    bindings: { TEST_PLACEMENT_FAILURES: String(placementFailures), DEMO_ORIGIN: ORIGIN, DEMO_SITE: 'https://run-test.example', DEMO_NAME: name, DEMO_ORIGIN_VAR: 'AUTH_ORIGIN', DEMO_MAX_INSTANCES: String(max),
      DEMO_SETTINGS: JSON.stringify({ MAIL_FROM: 'demo@demo.invalid' }), TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: 'secret-key', RER_DEMO_OPERATOR_TOKEN: 'operator-only-test-credential-123456789', ...(idle ? { TEST_IDLE_MS: String(idle) } : {}), ...(evictMs ? { TEST_EVICT_MS: String(evictMs) } : {}), ...(cleanupMs ? { TEST_CLEANUP_MS: String(cleanupMs) } : {}), ...(startMs ? { TEST_START_MS: String(startMs), TEST_PROBE_MS: String(probeMs ?? startMs) } : {}) },
    serviceBindings: { APP: app },
    outboundService: async request => {
      assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      if (siteverify) return siteverify(request);
      const form = new URLSearchParams(await request.text());
      verified.push(form.get('secret'));
      return Response.json({ success: form.get('response') === 'passed' });
    },
  }));
  const fetch = (path, init = {}) => mf.dispatchFetch(ORIGIN + path, { redirect: 'manual', ...init });
  const begin = ({ ip = '203.0.113.1', token = 'passed', origin = ORIGIN, headers = {} } = {}) => fetch('/__demo/start', { method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ 'cf-turnstile-response': token }) });
  const start = async (options = {}) => {
    let response = await begin(options);
    for (let polls = 0; response.status === 202; polls++) {
      if (polls > 1000) throw new Error('start never settled');
      const cookie = cookieHeader(response);
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 25));
      response = await fetch('/__demo/status', { headers: { ...options.headers, cookie } });
    }
    return response;
  };
  return { mf, demos, verified, fetch, begin, start };
}

export const demoCookie = response => response.headers.getSetCookie().find(cookie => cookie.startsWith('rer_demo=') && !cookie.startsWith('rer_demo=;'));
export const cookieHeader = response => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
