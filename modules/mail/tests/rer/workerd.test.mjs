import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../runtime/harness.mjs';

const signIn = { deliveryId: 'sign-in-1', from: 'Support <support@example.test>', to: ['reader@example.test'], subject: 'Your sign-in link',
  text: 'Sign in: https://app.example.test/auth/confirm', headers: { 'Auto-Submitted': 'auto-generated' } };
const notice = { deliveryId: 'notice-1', from: 'News <news@example.test>', to: ['reader@example.test'], subject: 'A new post', text: 'A new post is up.',
  headers: { 'List-Unsubscribe': '<https://app.example.test/unsubscribe/abc>, <mailto:leave@example.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };

test('a Worker sends sign-in and one-click unsubscribe mail through the rer relay and never follows a redirect', async () => {
  const relay = [];
  let status = 202;
  const worker = await createWorker('tests/rer/relay-worker.mjs', ['index.mjs'], async request => {
    relay.push({ url: request.url, body: await request.json() });
    return new Response(null, { status, headers: status === 302 ? { location: 'https://elsewhere.example.test/capture' } : {} });
  });
  const send = async message => (await worker.dispatchFetch('https://mail.test', { method: 'POST', body: JSON.stringify(message) })).json();
  try {
    assert.deepEqual(await send(signIn), { provider: 'rer', status: 'accepted', providerMessageId: null });
    assert.deepEqual(await send(notice), { provider: 'rer', status: 'accepted', providerMessageId: null });
    // The relay stamps Auto-Submitted itself; one-click unsubscribe travels as its two fields.
    assert.deepEqual(relay.map(request => request.body), [
      { to: 'reader@example.test', subject: signIn.subject, text: signIn.text },
      { to: 'reader@example.test', subject: notice.subject, text: notice.text,
        listUnsubscribe: '<https://app.example.test/unsubscribe/abc>, <mailto:leave@example.test>', listUnsubscribePost: true },
    ]);
    status = 302;
    assert.deepEqual(await send(signIn), { provider: 'rer', status: 'rejected', providerMessageId: null, code: 'provider_redirected' });
    assert.deepEqual(relay.map(request => new URL(request.url).host), Array(3).fill('managed.example.test'));
    // What the relay would refuse with a 400 is refused before any request.
    for (const headers of [{ 'Auto-Submitted': 'auto-replied' }, { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      { 'List-Unsubscribe': '<mailto:leave@example.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      { 'List-Unsubscribe': '<https://a.example.test/1>, <https://b.example.test/2>, <mailto:leave@example.test>' },
      { 'List-Unsubscribe': `<https://app.example.test/${'u'.repeat(2000)}>` }, { 'Message-ID': '<id@example.test>' }]) {
      const result = await send({ ...notice, headers });
      assert.ok(result.error, JSON.stringify(headers));
    }
    assert.equal(relay.length, 3);
  } finally { await worker.dispose(); }
});
