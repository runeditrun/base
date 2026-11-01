import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createProtocol } from '../../scripts/base-cli/modules/agent-door/conformance/protocol.mjs';
import { accessToken, autonomousPolicy } from '../../scripts/base-cli/modules/agent-door/conformance/crypto.mjs';
import { readAllDecisions, readDecisions } from '../../scripts/base-cli/modules/agent-door/conformance/business.mjs';
import { DOOR_REFUSAL_CODES } from '../../scripts/base-cli/modules/agent-door/refusal-codes.mjs';
import { auditLink, keepsLink, linkShaped, malformedLinks, observed, recordLink } from '../../scripts/base-cli/modules/agent-door/conformance/links.mjs';
import { signSettings, testDocument, testTrust } from '../../../modules/business-settings/testing/index.mjs';

// BASE-AGENT-015 journey on the production Worker and real D1, with the
// verifier as the official-schema fake Business and a fake paid mail edge.
// It also proves the BASE-AGENT-014 points that need native or edge control.
const successful = answer => { assert.equal(answer.result?.isError, false, JSON.stringify(answer.body?.error ?? answer.result)); return answer.result.structuredContent; };
const cookieOf = response => response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
const tokenIn = mail => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');

async function ownerClaimTrust() {
 const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const issuer = `https://links-business-${randomUUID()}.invalid`, kid = randomUUID(), installationId = randomUUID();
 return { signer: { issuer, kid, installationId, privateKey: pair.privateKey }, bindings: { RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
  RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify({ [kid]: await webcrypto.subtle.exportKey('jwk', pair.publicKey) }) } };
}

export async function businessLinks(root) {
 const { emittedRuntime, owner, setupToken } = await import('../operator-auth/emitted-runtime.mjs');
 const points = [], add = (id, ok, detail) => points.push({ id, ok: Boolean(ok), ...(ok ? {} : { detail: String(detail) }) });
 const trust = await ownerClaimTrust(), ownerId = randomUUID();
 // The paid mail edge: hold one request in flight, or fail one, on demand.
 const edge = { mode: null };
 const outbound = async request => {
  if (!edge.mode || request.url !== 'https://api.resend.com/emails') return undefined;
  const mode = edge.mode; edge.mode = null;
  if (mode === 'fail') return new Response('provider unavailable', { status: 503 });
  edge.reached(); await edge.released; return undefined;
 };
 const runtime = await emittedRuntime({ files: true, outbound, bindings: { ...trust.bindings, RER_BUSINESS_TRUST: JSON.stringify(testTrust({ email: owner })) } });
 const origin = runtime.origin, call = (path, init) => runtime.call(path, init);
 const request = (url, { headers, body, method } = {}) => { const target = new URL(url, origin); return call(target.pathname + target.search, { method: method ?? 'GET', headers: Object.fromEntries(new Headers(headers)), body }); };
 const open = async (link, cookie, headers = {}) => observed(await call(new URL(link, origin).pathname + new URL(link, origin).search, { cookie, headers }));
 const surface = JSON.parse(await readFile(join(root, 'agent-surface.json'), 'utf8'));
 const directory = process.env.AGENT_DOOR_SCREENSHOTS ?? join(root, '.cache', 'business-link-screenshots');
 await mkdir(directory, { recursive: true });
 const screenshots = [];
 let browser;
 try {
  const boot = await call('/auth/bootstrap', { method: 'POST', input: { token: setupToken, displayName: 'Links Owner' } });
  assert.equal(boot.status, 303); const cookie = cookieOf(boot); await boot.body?.cancel();
  const settings = await call('/api/rer/business-settings', { method: 'POST', input: { settings: await signSettings(testDocument({ email: owner, owner_id: ownerId, team: null, business: 'links-business-1' })) } });
  assert.equal(settings.status, 200, await settings.text());
  const c = createProtocol({ fetch: request, origin, surface, signer: trust.signer, person: { sub: ownerId, email: owner, cookie }, consent: randomUUID(), agentId: randomUUID(), business: 'links-business-1', seq: 0, revision: 0, points });
  await c.adopt(autonomousPolicy());
  const marker = `m${randomUUID().replaceAll('-', '')}`;
  const person = async (name, email) => successful(await c.tool('base.people.create', { name, email, idempotency_key: randomUUID() })).id;
  const p1 = await person(`Linked ${marker}`, `${marker}@example.test`), p2 = await person('Linked Second', 'linked-second@example.test'), p3 = await person('Linked Erased', 'linked-erased@example.test');
  successful(await c.tool('base.people.note', { id: p1, body: `Note ${marker}`, idempotency_key: randomUUID() }));
  const invite = async (name, email, role) => {
   const answer = await c.tool('base.access.invite', { name, email, role, idempotency_key: randomUUID() });
   return { answer, id: answer.result?.structuredContent?.id };
  };
  const accept = async email => {
   const mail = runtime.mails.findLast(item => item.to?.includes?.(email) || item.to === email);
   const joined = await call('/auth/confirm', { method: 'POST', input: { token: tokenIn(mail) } });
   assert.equal(joined.status, 303); const session = cookieOf(joined); await joined.body?.cancel(); return session;
  };
  const admin = await invite('Linked Admin', 'linked-admin@example.test', 'admin'), adminCookie = await accept('linked-admin@example.test');

  // BASE-AGENT-014.3: a call held at the paid mail edge reads running, then its outcome arrives under the same id.
  const start = (await readAllDecisions(c)).cursor;
  const reached = new Promise(resolve => { edge.reached = resolve; }); edge.released = new Promise(resolve => { edge.release = resolve; }); edge.mode = 'hold';
  const pending = invite('Linked Member', 'linked-member@example.test', 'member');
  await reached;
  const during = await readAllDecisions(c, { after: start });
  const running = during.decisions.find(item => item.tool === 'base.access.invite' && item.outcome === 'running');
  add('BASE-AGENT-014.3.running', during.ok && running, 'A call in flight must read as running.');
  edge.release();
  const member = await pending, memberCookie = await accept('linked-member@example.test');
  const after = await readAllDecisions(c, { after: during.cursor });
  add('BASE-AGENT-014.3.later-outcome', running && member.answer.decision?.id === running.id && after.decisions.some(item => item.id === running.id && item.outcome === 'done'), 'The finished call must read again under the same id with its outcome.');
  // BASE-AGENT-014.4: a provider failure is the seed's own undocumented refusal, which reads refused.
  edge.mode = 'fail';
  const refused = await invite('Linked Unreachable', 'linked-unreachable@example.test', 'member');
  const nativeCode = refused.answer.result?._meta?.['com.runeditrun/error']?.code;
  const refusal = (await readAllDecisions(c, { after: after.cursor })).decisions.find(item => item.id === refused.answer.decision?.id);
  add('BASE-AGENT-014.4.native-code', nativeCode && !DOOR_REFUSAL_CODES.includes(nativeCode) && refusal?.outcome === 'refused' && refusal.code === 'refused', `An undocumented native refusal (${nativeCode}) must read refused (${JSON.stringify(refusal)}).`);
  // Record text, targets and names stay out of every decision.
  const all = await readAllDecisions(c), text = JSON.stringify(all.decisions);
  add('BASE-AGENT-014.4.record-text', all.ok && ![marker, p1, 'Linked Admin', 'linked-admin@example.test'].some(value => text.includes(value)), 'A decision carried record text, a target or a name.');

  // BASE-AGENT-015: links Business composes from custody and a reference.
  const links = { p1: recordLink(origin, `base://person/${p1}`), p2: recordLink(origin, `base://person/${p2}`), p3: recordLink(origin, `base://person/${p3}`),
   admin: recordLink(origin, `base://operator/${admin.id}`), audit: auditLink(origin, all.decisions[0].id),
   missing: recordLink(origin, `base://person/${randomUUID()}`), otherOperator: recordLink(origin, `base://operator/${randomUUID()}`), otherAudit: auditLink(origin, randomUUID()) };
  add('BASE-AGENT-015.shape', Object.entries(links).every(([key, link]) => linkShaped(key.endsWith('udit') || key === 'audit' ? 'audit' : 'record', link)), 'Links must have the published shape.');
  const unavailable = await open(links.missing + '&x=1');
  add('BASE-AGENT-015.5.page', unavailable.status === 404 && !unavailable.location && !unavailable.cookie && /data-link-unavailable/.test(unavailable.body), 'A refused link answers the not-available page.');
  const same = answer => answer.status === 404 && !answer.location && !answer.cookie && answer.body === unavailable.body;
  for (const [label, link] of malformedLinks(`base://person/${p1}`, all.decisions[0].id)) {
   const results = [await open(link), await open(link, cookie), await open(link, adminCookie)];
   add(`BASE-AGENT-015.5.${label}`, results.every(same), `${label} must be refused without a redirect: ${JSON.stringify(results.map(item => [item.status, item.location]))}`);
  }
  for (const [label, link] of Object.entries(links)) add(`BASE-AGENT-015.4.signed-out.${label}`, keepsLink(await open(link), link), `${label} must answer only the sign-in redirect that keeps the link.`);

  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const context = async session => {
   // The emitted listener's certificate is a disposable local one; requests are routed to it below.
   const created = await browser.newContext({ ignoreHTTPSErrors: true });
   await created.route(`${origin}/**`, async route => {
    const req = route.request(), url = new URL(req.url());
    const answer = await call(url.pathname + url.search, { method: req.method(), headers: await req.allHeaders(), ...(req.postDataBuffer() ? { body: req.postDataBuffer() } : {}) });
    await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: Buffer.from(await answer.arrayBuffer()) });
   });
   if (session) for (const item of session.split('; ')) { const [name, ...value] = item.split('='); await created.addCookies([{ name, value: value.join('='), url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }]); }
   return created;
  };
  const capture = async (page, label) => {
   for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    add(`BASE-AGENT-015.browser.${label}.${width}.overflow`, !await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${label} overflows at ${width}`);
    const axe = await new AxeBuilder({ page }).analyze();
    const serious = axe.violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id);
    add(`BASE-AGENT-015.browser.${label}.${width}.axe`, serious.length === 0, `${label} axe at ${width}: ${serious.join(', ')}`);
    const file = join(directory, `${label}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
   }
  };

  // .3: setup is still required. Anyone but the owner sees that, with no record detail.
  const adminPage = await (await context(adminCookie)).newPage();
  await adminPage.goto(links.p1, { waitUntil: 'networkidle' });
  const required = await adminPage.content();
  add('BASE-AGENT-015.3.not-owner', await adminPage.locator('[data-setup-required]').count() === 1 && ![marker, p1, 'Linked'].some(value => required.includes(value)), 'A person who cannot finish setup must see only that setup is required.');
  await capture(adminPage, 'setup-required');
  // The owner sees setup, finishes it and lands on the linked record.
  const ownerContext = await context(cookie), ownerPage = await ownerContext.newPage();
  await ownerPage.goto(links.p1, { waitUntil: 'networkidle' });
  const setupUrl = new URL(ownerPage.url());
  add('BASE-AGENT-015.3.setup', setupUrl.pathname === '/setup' && setupUrl.searchParams.get('returnTo') === new URL(links.p1).pathname + new URL(links.p1).search, `The owner must see setup that keeps the link (${setupUrl.pathname}).`);
  await capture(ownerPage, 'setup');
  await ownerPage.getByRole('checkbox').check();
  await Promise.all([ownerPage.waitForURL(`**/app/people/${p1}`), ownerPage.getByRole('button', { name: 'Finish setup' }).click()]);
  add('BASE-AGENT-015.3.lands', new URL(ownerPage.url()).pathname === `/app/people/${p1}` && await ownerPage.locator(`[data-record-id="${p1}"]`).count() === 1, 'After setup the owner must land on the linked record.');
  await capture(ownerPage, 'person');

  // .1: each declared type and an audit row reach their own pages; two references, two pages.
  const targets = {};
  for (const label of ['p1', 'p2', 'admin', 'audit']) {
   const answer = await open(links[label], cookie);
   targets[label] = answer.location;
   const page = answer.status === 303 && answer.location?.startsWith('/') ? await call(answer.location, { cookie }) : null;
   add(`BASE-AGENT-015.1.${label}`, page?.status === 200 && !answer.cookie, `${label} must reach its own page (${answer.status} ${answer.location}).`);
   await page?.body?.cancel();
  }
  add('BASE-AGENT-015.1.distinct', new Set(Object.values(targets)).size === 4 && targets.p1 === `/app/people/${p1}` && targets.admin === `/app/operators/${admin.id}` && targets.audit === `/agents/audit/${all.decisions[0].id}`, `Each reference must reach its own page: ${JSON.stringify(targets)}`);
  for (const [label, link] of [['operator', links.admin], ['audit', links.audit]]) {
   await ownerPage.goto(link, { waitUntil: 'networkidle' });
   await capture(ownerPage, label);
  }

  // .2: signed out, the link survives native sign-in by a magic link confirmed in another browser.
  const outside = await (await context()).newPage();
  await outside.goto(links.p2, { waitUntil: 'networkidle' });
  add('BASE-AGENT-015.2.signin', new URL(outside.url()).pathname === '/signin', `A signed-out person must reach native sign-in (${outside.url()}).`);
  await capture(outside, 'signin');
  const sent = runtime.mails.length;
  await outside.getByLabel('Email').fill(owner);
  await Promise.all([outside.waitForLoadState('networkidle'), outside.getByRole('button', { name: 'Email a sign-in link' }).click()]);
  const confirmLink = runtime.mails.slice(sent).find(item => item.to?.includes?.(owner) || item.to === owner)?.text.match(/https?:\/\/\S+/)?.[0];
  const elsewhere = await (await context()).newPage();
  await elsewhere.goto(confirmLink, { waitUntil: 'networkidle' });
  await Promise.all([elsewhere.waitForURL(`**/app/people/${p2}`), elsewhere.getByRole('button', { name: 'Confirm' }).click()]);
  add('BASE-AGENT-015.2.lands', new URL(elsewhere.url()).pathname === `/app/people/${p2}`, `The confirming browser must land on the linked record, not the app root (${elsewhere.url()}).`);
  const replayed = await call('/auth/confirm', { method: 'POST', input: { token: new URL(confirmLink).searchParams.get('token') } });
  add('BASE-AGENT-015.7.magic-link-replay', replayed.status !== 303 && !cookieOf(replayed), 'A replayed magic link must admit no one.'); await replayed.body?.cancel();

  // .4: missing, deleted, out-of-access and other-installation references read the same.
  // Erasure redacts its own call too, so its answer is the value-free subject_erased tombstone.
  const erased = await c.tool('base.people.erase', { id: p3, idempotency_key: randomUUID() });
  assert.equal(erased.result?._meta?.['com.runeditrun/error']?.code ?? 'done', 'subject_erased');
  for (const label of ['missing', 'p3', 'otherOperator', 'otherAudit']) add(`BASE-AGENT-015.4.${label}`, same(await open(links[label], cookie)), `${label} must read like every other unavailable link.`);
  add('BASE-AGENT-015.4.out-of-access', same(await open(links.p1, memberCookie)) && same(await open(links.audit, memberCookie)), 'A person without access must read the same.');
  const before = await open(links.p1, adminCookie);
  successful(await c.tool('base.access.role', { id: admin.id, role: 'member', idempotency_key: randomUUID() }));
  const stale = await open(links.p1, adminCookie);
  await call('/auth/magic-link', { method: 'POST', input: { email: 'linked-admin@example.test' } });
  const again = await call('/auth/confirm', { method: 'POST', input: { token: tokenIn(runtime.mails.findLast(item => item.to?.includes?.('linked-admin@example.test') || item.to === 'linked-admin@example.test')) } });
  const demoted = cookieOf(again); await again.body?.cancel();
  add('BASE-AGENT-015.4.access-removed', before.location === `/app/people/${p1}` && (stale.status === 303 && keepsLink(stale, links.p1) || same(stale)) && same(await open(links.p1, demoted)), 'Access removed after a link was made must refuse it.');
  await ownerPage.goto(links.missing, { waitUntil: 'networkidle' });
  await capture(ownerPage, 'unavailable');

  // .6: borrowed credentials create no session and grant nothing.
  const grant = randomUUID() + randomUUID(), ownerRow = await runtime.db.prepare("SELECT id,version FROM oa_operators WHERE role='owner'").first();
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`owner-signin\0${grant}`))).toString('hex');
  await runtime.db.prepare('INSERT INTO oa_owner_signins(id,token_hash,operator_id,operator_version,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(randomUUID(), digest, ownerRow.id, ownerRow.version, Date.now(), Date.now() + 900_000).run();
  for (const [label, headers] of [['mcp-token', { authorization: `Bearer ${await accessToken(c)}` }], ['business-cookie', { cookie: `__Host-business_session=${randomUUID()}` }],
   ['deployment-credential', { authorization: `Bearer ${grant}`, cookie: `rer_owner_signin=${grant}` }]]) add(`BASE-AGENT-015.6.${label}`, keepsLink(await open(links.p1, undefined, headers), links.p1), `${label} must create no session.`);
  add('BASE-AGENT-015.6.grant-unused', (await runtime.db.prepare('SELECT consumed_at FROM oa_owner_signins WHERE token_hash=?').bind(digest).first()).consumed_at === null, 'The deployment credential must stay unused.');

  // .7: replay, a later use and another person open nothing without sign-in and current access.
  const first = await open(links.p1, cookie), second = await open(links.p1, cookie);
  add('BASE-AGENT-015.7.replay', first.location === second.location && keepsLink(await open(links.p1), links.p1) && keepsLink(await open(links.p1), links.p1), 'A replayed link must need native sign-in each time.');
  add('BASE-AGENT-015.7.other-person', same(await open(links.p1, memberCookie)), 'Another person without access must open nothing.');

  // BASE-AGENT-014.6: after unpairing the former Business reads nothing more; a new pairing reads nothing from before.
  c.adoptedPolicy = undefined; // the unpaired installation renews nothing
  const swap = values => runtime.redeploy((source, path) => path.endsWith('/test-demo-entry.mjs')
   ? source.replace('return worker.fetch(new Request(request, { headers }), env, execution);', `return worker.fetch(new Request(request, { headers }), { ...env, ...${JSON.stringify(values)} }, execution);`) : source);
  await swap({ RER_OWNER_CLAIM_ISSUER: null, RER_OWNER_CLAIM_INSTALLATION_ID: null, RER_OWNER_CLAIM_PUBLIC_KEYS: null });
  const unpaired = await readDecisions(c);
  add('BASE-AGENT-014.6.unpaired', unpaired.status === 404 && unpaired.body?.code === 'not_found', `After unpairing the former Business must read nothing (${unpaired.status}).`);
  const next = await ownerClaimTrust();
  await swap(next.bindings);
  const repaired = createProtocol({ fetch: request, origin, surface, signer: next.signer, person: { sub: ownerId, email: owner, cookie }, consent: randomUUID(), agentId: randomUUID(), business: 'links-business-2', seq: c.seq, revision: c.revision, points });
  await repaired.adopt(autonomousPolicy());
  const fresh = await readAllDecisions(repaired);
  const witness = await repaired.tool(surface.witness.tool, {});
  const own = await readAllDecisions(repaired);
  add('BASE-AGENT-014.6.new-trust', fresh.ok && fresh.decisions.length === 0 && own.decisions.length === 1 && own.decisions[0].id === witness.decision?.id, 'A Business paired under a new trust must read only its own pairing.');
  add('BASE-AGENT-014.6.former-trust', (await readDecisions(c)).status === 401, 'The former trust must read nothing more.');

  assert.deepEqual(points.filter(point => !point.ok), []);
  return { points: points.length, widths: [1440, 390], screenshots: screenshots.length, summary: 'passed' };
 } finally {
  await browser?.close();
  await runtime.close();
 }
}
