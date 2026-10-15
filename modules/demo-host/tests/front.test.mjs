import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, front, demoCookie, cookieHeader } from './front.mjs';

test('a visitor starts their own signed-in demo, and only their cookie reaches it', async () => {
  const { mf, demos, verified, fetch, start } = await front();
  try {
    const page = await fetch('/');
    assert.equal(page.status, 200);
    assert.deepEqual(page.headers.getSetCookie(), []);
    const html = await page.text();
    // Without JavaScript the form still posts; with it, every Turnstile callback the widget names exists and its fetch is allowed.
    assert.match(html, /<form id="start" method="post" action="\/__demo\/start"[^>]*>/);
    assert.doesNotMatch(html, /<button[^>]*disabled/);
    const callbacks = [...html.matchAll(/data-[a-z-]*callback="([^"]+)"/g)].map(match => match[1]);
    assert.ok(callbacks.length >= 2 && callbacks.every(name => html.includes(`window.${name}=`)), callbacks.join());
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(html, /role="status"/);

    const started = await start();
    assert.equal(started.status, 303);
    assert.equal(started.headers.get('location'), '/app');
    assert.deepEqual(verified, ['secret-key']);
    const cookie = demoCookie(started), id = /^rer_demo=([0-9a-f]{64});/.exec(cookie)?.[1];
    assert.ok(id, cookie);
    for (const attribute of ['Domain=demo.run-test.example', 'Path=/', 'Max-Age=3600', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.split('; ').includes(attribute), attribute);
    assert.ok(started.headers.getSetCookie().some(value => value.startsWith(`__Host-operator_session=${id};`)), 'the owner session from the claim is relayed');

    // The container starts in demo mode with its own secrets and the claim's public key.
    const { env } = demos.get(id);
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

test("the page's own start (Accept: application/json) answers the sign-in location or a notice, with the same checks", async () => {
  const { mf, fetch, start } = await front({ max: 1 });
  const json = { accept: 'application/json' };
  try {
    const notice = async (response, status) => {
      assert.equal(response.status, status);
      assert.equal(demoCookie(response), undefined);
      const { notice } = await response.json();
      assert.ok(typeof notice === 'string' && notice.length > 0);
    };
    await notice(await start({ origin: 'https://elsewhere.example', headers: json }), 403);
    await notice(await start({ token: 'failed', headers: json }), 403);
    const started = await start({ headers: json });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { location: '/app' });
    const id = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(started))?.[1];
    assert.ok(id);
    assert.equal(await (await fetch('/app', { headers: { cookie: cookieHeader(started) } })).text(), `${id} /app`);
    await notice(await start({ headers: json }), 503);
    await notice(await start({ headers: json }), 429);
  } finally { await mf.dispose(); }
});

test("the page's own start reports a failed startup as a notice and frees its place", async () => {
  let healthy = false;
  const { mf, start } = await front({ max: 1, startMs: 300, probeMs: 80, health: () => new Response(null, { status: healthy ? 200 : 503 }) });
  try {
    const failed = await start({ headers: { accept: 'application/json' } });
    assert.equal(failed.status, 502);
    assert.ok(failed.headers.get('x-rer-demo-correlation'));
    assert.ok((await failed.json()).notice);
    healthy = true;
    assert.equal((await start({ ip: '203.0.113.14', headers: { accept: 'application/json' } })).status, 200);
  } finally { await mf.dispose(); }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an idle visitor keeps their demo past the point where the platform evicts a quiet object', async () => {
  // 3 s idle stands for 15 minutes; eviction after 0.3 s of no event, for the platform's two to three minutes.
  const { mf, demos, fetch, start } = await front({ idle: 3000, evictMs: 300 });
  try {
    const started = await start(), id = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(started))[1];
    await sleep(1500);
    const later = await fetch('/app', { headers: { cookie: cookieHeader(started) } });
    assert.equal(later.status, 200);
    assert.equal(await later.text(), `${id} /app`);
    assert.equal(demos.get(id).evicted, undefined, 'the container was never stopped');
  } finally { await mf.dispose(); }
});

test('an idle demo ends: its container is destroyed, its place freed, and its visitor sees the ended page', async () => {
  const { mf, demos, fetch, start } = await front({ max: 1, idle: 1500, evictMs: 300 });
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

test('a container the platform stopped answers the ended page, not an error, and frees its place', async () => {
  const { mf, demos, fetch, start } = await front({ max: 1 });
  try {
    const started = await start(), id = /^rer_demo=([0-9a-f]{64});/.exec(demoCookie(started))[1];
    demos.get(id).stop = true;
    const ended = await fetch('/app', { headers: { cookie: cookieHeader(started) } });
    assert.equal(ended.status, 410);
    assert.match(await ended.text(), /This demo has ended[\s\S]*href="\/">Start a new demo/);
    assert.ok(ended.headers.getSetCookie().some(cookie => cookie.startsWith('rer_demo=;') && cookie.includes('Max-Age=0')));
    assert.equal((await start({ ip: '203.0.113.4' })).status, 303);
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
