import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './runtime.mjs';

// A hosted demo's sign-in mail is captured (a development receipt), not sent. Under
// the explicit demo policy the visitor who asked gets the captured link; the HTTPS
// origin, Origin checks and the secure __Host- cookie stay exactly as in production.
// Without the policy a hosted app refuses the same receipt, as before.

const captured = response => new URL(response.headers.get('location'), 'https://auth.test');

test('a hosted demo captures sign-in mail and shows the visitor its link, keeping HTTPS, Origin and secure-cookie checks', async () => {
  const r = await runtime({ demoMailCapture: true }, { mailStatus: 'development' });
  try {
    // The owner claim entry (bootstrap) is still the demo's way in.
    const owner = await r.bootstrap();
    assert.match(owner, /^__Host-operator_session=/);
    // A native sign-in form post lands on the captured link's confirmation page.
    const asked = await r.call('/auth/magic-link', { method: 'POST', form: { email: 'owner@example.com' } });
    assert.equal(asked.status, 303);
    const link = captured(asked);
    assert.equal(link.pathname, '/auth/confirm');
    assert.equal((await r.mails()).length, 1, 'the mail was captured in the outbox');
    assert.equal(new URL((await r.mails())[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get('token'), link.searchParams.get('token'), 'the visitor sees the captured link itself');
    const page = await r.call(link.pathname + link.search);
    assert.equal(page.status, 200);
    const confirmed = await r.call('/auth/confirm', { method: 'POST', input: { token: link.searchParams.get('token') } });
    assert.equal(confirmed.status, 303);
    assert.match(confirmed.headers.get('set-cookie'), /^__Host-operator_session=[^;]+;.*; Secure$/);
    // A JSON client gets the captured link; an unknown address gets the uniform answer only.
    const json = await r.call('/auth/magic-link', { method: 'POST', input: { email: 'owner@example.com' } });
    assert.equal(json.status, 202);
    assert.match((await json.json()).captured, /^\/auth\/confirm\?token=[A-Za-z0-9_-]{43}$/);
    const unknown = await r.call('/auth/magic-link', { method: 'POST', input: { email: 'nobody@example.com' } });
    assert.deepEqual(await unknown.json(), { status: 'accepted' });
    // Origin and host checks are unchanged.
    assert.equal((await r.call('/auth/magic-link', { method: 'POST', input: { email: 'owner@example.com' }, origin: 'https://other.test' })).status, 403);
    assert.equal((await r.call('/auth/magic-link', { method: 'POST', input: { email: 'owner@example.com' }, host: 'other.test' })).status, 403);
  } finally { await r.close(); }
});

test('a normal hosted deploy refuses a captured receipt for sign-in mail and shows no link', async () => {
  const r = await runtime({}, { mailStatus: 'development' });
  try {
    await r.bootstrap();
    const json = await r.call('/auth/magic-link', { method: 'POST', input: { email: 'owner@example.com' } });
    assert.equal(json.status, 503);
    assert.deepEqual(await json.json(), { error: 'mail_unavailable' });
    const form = await r.call('/auth/magic-link', { method: 'POST', form: { email: 'owner@example.com' } });
    assert.equal(form.status, 303);
    assert.equal(captured(form).pathname, '/signin');
    assert.equal(captured(form).searchParams.get('notice'), 'mail_unavailable');
    // The captured message's link was revoked: it cannot sign anyone in.
    const [mail] = await r.mails();
    const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    assert.equal((await r.call('/auth/confirm', { method: 'POST', input: { token } })).status, 400);
  } finally { await r.close(); }
});
