import test from 'node:test';
import assert from 'node:assert/strict';
import egress from '../demo-egress.mjs';

function network(reply = () => new Response('public result')) {
  const requests = [];
  return { requests, env: { RER_DEMO: '1', NETWORK: { fetch(request) { requests.push(request); return reply(request); } } } };
}

test('demo public reads and read probes reach the network while direct messaging transports do not', async () => {
  const { env, requests } = network();
  for (const method of ['GET', 'HEAD', 'POST']) {
    const response = await egress.fetch(new Request('https://public.example/check', { method }), env);
    assert.equal(await response.text(), 'public result');
    assert.equal(requests.at(-1).method, method);
  }
  const reached = requests.length;
  for (const url of ['https://api.sendgrid.com/v3/mail/send', 'https://api.resend.com/emails', 'https://api.twilio.com/2010-04-01/Accounts/demo/Messages.json', 'https://API.TWILIO.COM./messages', 'http://public.example:587/']) {
    await assert.rejects(egress.fetch(new Request(url, { method: 'POST' }), env), TypeError);
  }
  assert.equal(requests.length, reached);
});

test('demo redirects are checked before contacting a messaging provider', async () => {
  const { env, requests } = network(() => new Response(null, { status: 307, headers: { location: 'https://api.sendgrid.com/v3/mail/send' } }));
  await assert.rejects(egress.fetch(new Request('https://public.example/redirect'), env), TypeError);
  assert.deepEqual(requests.map(request => request.url), ['https://public.example/redirect']);
  const manual = await egress.fetch(new Request('https://public.example/redirect', { redirect: 'manual' }), env);
  assert.equal(manual.status, 307);
  await assert.rejects(egress.fetch(new Request('https://public.example/redirect', { redirect: 'error' }), env), TypeError);
});

test('public redirects preserve fetch body rules and remove cross-origin credentials', async () => {
  const { env, requests } = network(request => request.url.endsWith('/redirect')
    ? new Response(null, { status: 303, headers: { location: 'https://other.example/result' } })
    : new Response('checked'));
  const response = await egress.fetch(new Request('https://public.example/redirect', { method: 'POST', body: 'probe', headers: { authorization: 'test-only', cookie: 'test=1', 'content-type': 'text/plain' } }), env);
  assert.equal(await response.text(), 'checked');
  assert.equal(await requests[0].text(), 'probe');
  assert.equal(requests[1].method, 'GET');
  for (const header of ['authorization', 'cookie', 'content-type']) assert.equal(requests[1].headers.get(header), null);
  assert.equal(await requests[1].text(), '');
});

test('ordinary container egress leaves delivery transports available', async () => {
  const { env, requests } = network();
  env.RER_DEMO = '';
  const response = await egress.fetch(new Request('https://api.sendgrid.com/v3/mail/send', { method: 'POST' }), env);
  assert.equal(await response.text(), 'public result');
  assert.equal(requests.length, 1);
});
