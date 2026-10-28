import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { verificationReviewers } from './agent-reviewers.mjs';
import { checkAgentDoor } from './agent-door.mjs';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';

const ownerEmail = 'owner@example.invalid', reviewerEmail = 'reviewer@example.invalid';
const session = () => `session=${randomBytes(32).toString('hex')}`;
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-reviewers-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const cookie = session();
 await writeFile(join(root, 'reviewer.mjs'), `export let seen, mailbox;
export default async function ({mail}) { mailbox = mail; seen = mail.read({limit:20});
 return new Response(null, {status:303, headers:{'Set-Cookie':${JSON.stringify(cookie)}}}); }
`);
 const declaration = [{ label: 'quality', email: reviewerEmail, initializer: 'reviewer.mjs' }];
 return { root, declaration, cookie, module: () => import(pathToFileURL(join(root, 'reviewer.mjs'))) };
}
const request = (url, body) => new Request(url, { method: 'POST', body: JSON.stringify(body) });
const resend = body => request('https://api.resend.com/emails', { to: [reviewerEmail], ...body });
const accepted = () => Response.json({ id: crypto.randomUUID() });

test('reviewer declarations refuse duplicate identities, unknown keys, invalid modules and path escapes', async t => {
 const f = await fixture(t), item = f.declaration[0];
 await symlink('/etc/hosts', join(f.root, 'escape.mjs'));
 await writeFile(join(f.root, 'invalid.mjs'), 'export default {};');
 for (const value of [null, {}, [], Array(9).fill(item), [item, item], [{ ...item, email: ownerEmail }],
  [item, { ...item, label: 'other' }], [{ ...item, label: '../escape' }], [{ ...item, email: 'UPPER@example.invalid' }],
  [{ ...item, initializer: 'escape.mjs' }], [{ ...item, initializer: '../outside.mjs' }], [{ ...item, initializer: 'invalid.mjs' }],
  [{ ...item, authority: 'admin' }]]) {
  await assert.rejects(() => verificationReviewers(f.root, value, ownerEmail));
 }
 const absent = await verificationReviewers(f.root, undefined, ownerEmail);
 assert.equal(absent.observes(resend({})), false);
 assert.deepEqual(absent.points(), []);
 absent.close();
});

test('reviewer mail is recipient scoped, bounded, accepted only, and destroyed at close', async t => {
 let now = Date.now();
 t.mock.method(Date, 'now', () => now);
 const f = await fixture(t), reviewers = await verificationReviewers(f.root, f.declaration, ownerEmail);
 t.after(() => reviewers.close());
 await reviewers.capture(resend({ text: 'old' }), accepted());
 now += 300_001;
 await reviewers.capture(resend({ text: 'rejected' }), new Response(null, { status: 403 }));
 await reviewers.capture(resend({ text: 'unacknowledged' }), Response.json({ error: 'refused' }));
 await reviewers.capture(resend({ to: ['stranger@example.invalid'], text: 'private' }), accepted());
 await reviewers.capture(request('https://api.resend.com/other', { to: [reviewerEmail], text: 'wrong path' }), accepted());
 await reviewers.capture(resend({ text: 'x'.repeat(65_537) }), accepted());
 for (let i = 0; i < 22; i++) await reviewers.capture(resend({ text: String(i) }), accepted());
 await reviewers.capture(request('https://api.sendgrid.com/v3/mail/send', { personalizations: [{ to: [{ email: reviewerEmail }] }],
  subject: 'Grid', content: [{ type: 'text/plain', value: 'grid' }] }), new Response(null, { status: 202 }));
 await reviewers.capture(request('https://api.cloudflare.com/client/v4/accounts/fixture/email/sending/send', { to: [reviewerEmail], text: 'cloud' }),
  Response.json({ success: true, result: { accepted: [reviewerEmail] } }));
 await reviewers.capture(request('https://api.cloudflare.com/client/v4/accounts/fixture/email/sending/send', { to: [reviewerEmail], text: 'rejected cloud' }),
  Response.json({ success: true, result: { accepted: [], rejected: [reviewerEmail] } }));
 const result = await reviewers.initialize('quality', { cookie: session() }, { request: () => {}, origin: 'https://fixture.invalid' });
 assert.equal(result.cookie, f.cookie);
 const loaded = await f.module();
 assert.equal(loaded.seen.length, 20);
 assert.equal(loaded.seen[0].text, '4');
 assert.deepEqual(loaded.seen.slice(-2).map(message => message.text), ['grid', 'cloud']);
 assert.deepEqual(Object.keys(loaded.seen[0]).sort(), ['at', 'html', 'id', 'subject', 'text']);
 assert.throws(() => loaded.mailbox.read({ email: 'stranger@example.invalid' }));
 assert.throws(() => loaded.mailbox.read({ limit: 21 }));
 assert.throws(() => loaded.mailbox.read({ maxAgeMs: 300_001 }));
 loaded.seen[0].text = 'mutated copy';
 assert.equal(loaded.mailbox.read({ limit: 20 })[0].text, '4');
 now += 300_001;
 assert.deepEqual(loaded.mailbox.read(), []);
 assert.equal(reviewers.points()[0].ok, true);
 await assert.rejects(() => reviewers.initialize('quality', { cookie: session() }, {}));
 await assert.rejects(() => reviewers.initialize('unknown', { cookie: session() }, {}));
 reviewers.close();
 assert.throws(() => loaded.mailbox.read());
});

test('native reviewer failures are redacted and never manufacture a passing lifecycle', async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, 'failure.mjs'), `export default async function () { throw new Error(${JSON.stringify(randomBytes(32).toString('hex'))}); }`);
 await writeFile(join(f.root, 'missing-session.mjs'), 'export default async () => new Response(null, {status:303});');
 await writeFile(join(f.root, 'owner-session.mjs'), "export default async ({owner}) => new Response(null, {status:303,headers:{'Set-Cookie':owner.cookie}});");
 for (const initializer of ['failure.mjs', 'missing-session.mjs', 'owner-session.mjs']) {
  const reviewers = await verificationReviewers(f.root, [{ ...f.declaration[0], initializer }], ownerEmail);
  try {
   assert.equal(reviewers.points()[0].ok, false);
   await assert.rejects(() => reviewers.initialize('quality', { cookie: session() }, {}), error => error.code === 'agent_reviewer_failed' && error.message.includes('confirmed session'));
   assert.equal(reviewers.points()[0].ok, false);
  } finally { reviewers.close(); }
 }
});

test('closing verification stops mail and session continuations already in flight', async t => {
 const f = await fixture(t);
 const reviewers = await verificationReviewers(f.root, f.declaration, ownerEmail);
 let deliver, reading;
 const started = new Promise(resolve => { reading = resolve; });
 const response = { ok: true, json: () => { reading(); return new Promise(resolve => { deliver = resolve; }); } };
 const capture = reviewers.capture(resend({ text: 'late invitation' }), response);
 await started;
 reviewers.close();
 deliver({ get id() { throw new Error('Closed capture must stop before reading the late receipt'); } });
 await capture;

 await writeFile(join(f.root, 'delayed.mjs'), `export let finish;
export default async () => new Promise(resolve => { finish = () => resolve(new Response(null, {status:303, headers:{'Set-Cookie':${JSON.stringify(f.cookie)}}})); });`);
 const delayed = await verificationReviewers(f.root, [{ ...f.declaration[0], initializer: 'delayed.mjs' }], ownerEmail);
 const pending = delayed.initialize('quality', { cookie: session() }, {});
 const module = await import(pathToFileURL(join(f.root, 'delayed.mjs')));
 delayed.close();
 module.finish();
 await assert.rejects(() => pending, { code: 'agent_reviewer_failed' });
 assert.equal(delayed.points()[0].ok, false);
});

test('native independent-reviewer fixture fails without its lifecycle and passes with it while same-person and invalid proofs still fail', { timeout: 150000 }, async t => {
 const root = await fixtureSeed(t, 'native-reviewer');
 await buildFixture(root);
 const file = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(file, 'utf8'));
 const declaredReviewers = surface.verification.reviewers;
 delete surface.verification.reviewers;
 await writeFile(file, JSON.stringify(surface));
 let before;
 await assert.rejects(() => checkAgentDoor(root, { report() {} }), error => {
  before = `${error.agentDoor?.points.filter(point => point.ok).length}/${error.agentDoor?.points.length}`;
  return error.code === 'agent_door_failed' && error.failures.includes('BASE-AGENT-001.owner-bootstrap');
 });
 surface.verification.reviewers = declaredReviewers;
 await writeFile(file, JSON.stringify(surface));
 const result = await checkAgentDoor(root, { report() {} });
 assert.equal(result.ok, true);
 assert.equal(result.points.find(point => point.id === 'BASE-AGENT-001.reviewer.quality.native-session')?.ok, true);
 t.diagnostic(`native reviewer: without hook ${before} FAIL owner-bootstrap; with hook ${result.points.length}/${result.points.length} PASS; same preparer HTTP 403 before/after; bad and reused confirmation HTTP 400.`);
});
