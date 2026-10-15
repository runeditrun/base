import { test } from 'node:test';
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
const ORIGIN = 'https://demo.run-test.example';

async function front({ max = 10, idle, health, startMs, probeMs, destroyFailures = 0, cleanupMs } = {}) {
  const demos = new Map();
  async function app(request) {
    const url = new URL(request.url), id = request.headers.get('x-demo');
    if (url.hostname === 'platform') {
      if (url.pathname === '/start') demos.set(id, { ...await request.json(), destroyed: false, requests: [] });
      else { if (destroyFailures-- > 0) return new Response(null, { status: 503 }); demos.get(id).destroyed = true; }
      return new Response(null, { status: 204 });
    }
    const demo = demos.get(id);
    if (!demo || demo.destroyed) return new Response('no container', { status: 502 });
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
    bindings: { DEMO_ORIGIN: ORIGIN, DEMO_SITE: 'https://run-test.example', DEMO_NAME: 'Test', DEMO_ORIGIN_VAR: 'AUTH_ORIGIN', DEMO_MAX_INSTANCES: String(max),
      DEMO_SETTINGS: JSON.stringify({ MAIL_FROM: 'demo@demo.invalid' }), TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key', RER_DEMO_OPERATOR_TOKEN: 'operator-only-test-credential-123456789', ...(idle ? { TEST_IDLE_MS: String(idle) } : {}), ...(cleanupMs ? { TEST_CLEANUP_MS: String(cleanupMs) } : {}), ...(startMs ? { TEST_START_MS: String(startMs), TEST_PROBE_MS: String(probeMs ?? startMs) } : {}) },
    serviceBindings: { APP: app },
    outboundService: async request => {
      assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const form = new URLSearchParams(await request.text());
      verified.push(form.get('secret'));
      return Response.json({ success: form.get('response') === 'passed' });
    },
  }));
  const fetch = (path, init = {}) => mf.dispatchFetch(ORIGIN + path, { redirect: 'manual', ...init });
  const start = ({ ip = '203.0.113.1', token = 'passed', origin = ORIGIN } = {}) => fetch('/__demo/start', { method: 'POST',
    headers: { origin, 'cf-connecting-ip': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ 'cf-turnstile-response': token }) });
  return { mf, demos, verified, fetch, start };
}

const demoCookie = response => response.headers.getSetCookie().find(cookie => cookie.startsWith('rer_demo='));
const cookieHeader = response => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

test('a visitor starts their own signed-in demo, and only their cookie reaches it', async () => {
  const { mf, demos, verified, fetch, start } = await front();
  try {
    const page = await fetch('/');
    assert.equal(page.status, 200);
    assert.deepEqual(page.headers.getSetCookie(), []);
    const html = await page.text();
    assert.match(html, /<form id="start" method="post" action="\/__demo\/start">/);
    assert.match(html, /class="cf-turnstile" data-sitekey="site-key"[^>]*data-callback="rerDemoStart"/);

    const started = await start();
    assert.equal(started.status, 303);
    assert.equal(started.headers.get('location'), '/app');
    assert.deepEqual(verified, ['secret-key']);
    const cookie = demoCookie(started), id = /^rer_demo=([0-9a-f]{64});/.exec(cookie)?.[1];
    assert.ok(id, cookie);
    for (const attribute of ['Domain=demo.run-test.example', 'Path=/', 'Max-Age=3600', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.split('; ').includes(attribute), attribute);
    assert.ok(started.headers.getSetCookie().some(value => value.startsWith(`__Host-operator_session=${id};`)), 'the owner session from the claim is relayed');

    // The container started in demo mode with no internet, its own secrets and the claim's public key.
    const { env, enableInternet } = demos.get(id);
    assert.equal(enableInternet, false);
    assert.equal(env.RER_DEMO, '1');
    assert.equal(env.AUTH_ORIGIN, ORIGIN);
    assert.equal(env.RER_INGRESS_ORIGIN, ORIGIN);
    assert.equal(env.OWNER_EMAIL, 'owner@demo.invalid');
    assert.equal(env.MAIL_FROM, 'demo@demo.invalid');
    assert.equal(env.RER_OWNER_CLAIM_INSTALLATION_ID, id);
    assert.match(env.SESSION_SECRET, /^[0-9a-f]{64}$/);
    assert.match(env.SETUP_TOKEN, /^[0-9a-f]{64}$/);
    assert.notEqual(env.SESSION_SECRET, env.SETUP_TOKEN);
    assert.ok(Date.parse(env.RER_DEMO_EXPIRES) - Date.now() > 59 * 60_000);
    assert.deepEqual(demos.get(id).requests.slice(-2), ['GET /health', 'POST /auth/owner-claim']);

    const signedIn = await fetch('/app', { headers: { cookie: cookieHeader(started) } });
    assert.equal(await signedIn.text(), `${id} /app`);

    // A second visitor gets another container; neither cookie reaches the other's.
    const other = await start({ ip: '203.0.113.2' }), otherId = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(other))[1];
    assert.notEqual(otherId, id);
    assert.notEqual(demos.get(otherId).env.SESSION_SECRET, env.SESSION_SECRET);
    assert.equal(await (await fetch('/app', { headers: { cookie: `rer_demo=${otherId}` } })).text(), `${otherId} /app`);

    // Without a cookie, or with a forged one, nothing of a demo is reachable.
    const before = demos.get(id).requests.length;
    for (const headers of [{}, { cookie: 'rer_demo=forged' }, { cookie: `rer_demo=${'0'.repeat(64)}` }]) {
      const response = await fetch('/app', { headers });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/');
    }
    assert.equal((await fetch('/app', { method: 'POST' })).status, 403);
    assert.equal(demos.get(id).requests.length, before);
  } finally { await mf.dispose(); }
});

test('a start is refused from another origin, without Turnstile, past 3 per IP a minute, and at capacity', async () => {
  const { mf, demos, start } = await front({ max: 1 });
  try {
    const refused = async (response, status, notice) => { assert.equal(response.status, status); assert.equal(demoCookie(response), undefined); assert.match(await response.text(), notice); };
    await refused(await start({ origin: 'https://elsewhere.example' }), 403, /Start the demo from this page/);
    await refused(await start({ token: 'failed' }), 403, /The check did not pass/);
    await refused(await start({ token: '' }), 403, /The check did not pass/);
    assert.equal(demos.size, 0);
    assert.equal((await start()).status, 303);
    assert.equal(demos.size, 1);
    await refused(await start(), 429, /Too many demos started from your network/);
    await refused(await start({ ip: '203.0.113.9' }), 503, /Every demo is in use right now/);
    assert.equal(demos.size, 1);
  } finally { await mf.dispose(); }
});

test('an idle demo ends: its container is destroyed, its place freed, and its visitor sees the ended page', async () => {
  const { mf, demos, fetch, start } = await front({ max: 1, idle: 1500 });
  try {
    const started = await start(), id = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(started))[1];
    for (let i = 0; i < 100 && !demos.get(id).destroyed; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(demos.get(id).destroyed, true);
    const ended = await fetch('/app', { headers: { cookie: cookieHeader(started) } });
    assert.equal(ended.status, 410);
    assert.match(await ended.text(), /This demo has ended[\s\S]*href="\/">Start a new demo/);
    assert.ok(ended.headers.getSetCookie().some(cookie => cookie.startsWith('rer_demo=;') && cookie.includes('Max-Age=0')));
    // The one place is free again.
    const again = await start({ ip: '203.0.113.3' });
    assert.equal(again.status, 303);
  } finally { await mf.dispose(); }
});


test('bounded readiness failures are private, clean up capacity, and permit a later healthy start', async () => {
  let failure = true;
  const { mf, demos, start, fetch } = await front({ max: 1, startMs: 400, probeMs: 80,
    health: () => failure ? new Promise(resolve => setTimeout(() => resolve(new Response('SECRET body', { status: 503 })), 300)) : Response.json({ ok: true }) });
  try {
    const before = Date.now(), refused = await start();
    assert.equal(refused.status, 502);
    assert.ok(Date.now() - before < 3000, 'the start is bounded even when probes are slow');
    const correlation = refused.headers.get('x-rer-demo-correlation');
    assert.ok(correlation);
    assert.equal(refused.headers.getSetCookie().length, 0);
    assert.doesNotMatch(await refused.text(), /SECRET|probe-timeout|health-deadline|platform-error/);
    assert.ok([...demos.values()].every(demo => demo.destroyed));
    // The public correlation is not an instance bearer or a diagnostics capability.
    const anonymous = await fetch('/__demo/diagnostics/' + correlation);
    assert.equal(anonymous.status, 303);
    const operatorPath = '/__demo/operator/' + correlation;
    assert.equal((await fetch(operatorPath)).status, 401);
    assert.equal((await fetch(operatorPath, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const operator = await fetch(operatorPath, { headers: { authorization: 'Bearer operator-only-test-credential-123456789' } });
    assert.equal(operator.status, 200);
    const diagnostic = await operator.text();
    assert.match(diagnostic, /probe-timeout/);
    assert.doesNotMatch(diagnostic, /SECRET|operator-only-test-credential/);
    failure = false;
    const started = await start({ ip: '203.0.113.10' });
    assert.equal(started.status, 303);
    assert.notEqual(started.headers.get('x-rer-demo-correlation'), demoCookie(started)?.split(';')[0].slice(9));
  } finally { await mf.dispose(); }
});


test('a platform exit during startup fails promptly and releases the reservation', async () => {
  let exit = true;
  const { mf, start, fetch } = await front({ max: 1, startMs: 5000,
    health: () => exit ? new Response(null, { status: 599 }) : Response.json({ ok: true }) });
  try {
    const before = Date.now(), failed = await start();
    assert.equal(failed.status, 502);
    assert.ok(Date.now() - before < 3000);
    const diagnostic = await fetch('/__demo/operator/' + failed.headers.get('x-rer-demo-correlation'), { headers: { authorization: 'Bearer operator-only-test-credential-123456789' } });
    const html = await diagnostic.text();
    assert.match(html, /exitCode/);
    assert.doesNotMatch(html, /SECRET/);
    exit = false;
    assert.equal((await start({ ip: '203.0.113.11' })).status, 303);
  } finally { await mf.dispose(); }
});


test('failed cleanup preserves the startup failure and holds capacity until destruction succeeds', async () => {
  let healthy = false;
  const { mf, start, demos } = await front({ max: 1, startMs: 80, cleanupMs: 500, destroyFailures: 1,
    health: () => new Response(null, { status: healthy ? 200 : 503 }) });
  try {
    const failed = await start();
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /SECRET/);
    healthy = true;
    assert.equal((await start({ ip: '203.0.113.12' })).status, 503);
    for (let i = 0; i < 100 && ![...demos.values()].every(demo => demo.destroyed); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok([...demos.values()].every(demo => demo.destroyed));
    assert.equal((await start({ ip: '203.0.113.13' })).status, 303);
  } finally { await mf.dispose(); }
});
