import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createMailSender, MailValidationError } from '../../index.mjs';

const config = () => ({ provider: 'rer', mode: 'production', apiKey: randomBytes(32).toString('hex'), relayUrl: 'https://managed.example.test/api/managed-mail/send' });
const message = () => ({ deliveryId: 'sign-in-17', from: 'Support <support@example.test>', to: ['Reader <reader@example.test>'], subject: 'Your sign-in link', text: 'Sign in: https://app.example.test/auth/confirm' });

async function relay(t, configuration) {
  const requests = [];
  let status = 202;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, method: request.method, headers: request.headers, body: body ? JSON.parse(body) : null });
    response.writeHead(status, { 'content-type': 'application/json', location: '/capture', 'retry-after': '60' });
    // Error bodies deliberately echo the credential: the adapter must discard it.
    response.end(JSON.stringify(status === 202 ? { accepted: true } : { error: configuration.apiKey }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {
    requests,
    respond: value => { status = value; },
    fetch: (url, init) => {
      assert.equal(url, configuration.relayUrl);
      assert.equal(init.redirect, 'error');
      // Only the test network edge maps the assigned HTTPS relay to loopback.
      return fetch(`http://127.0.0.1:${server.address().port}/api/managed-mail/send`, init);
    },
  };
}

test('public sender submits only the relay envelope and accepts 202 with or without HTML', async t => {
  const configuration = config(), edge = await relay(t, configuration);
  const sender = createMailSender(configuration, { fetch: edge.fetch });
  for (const html of [undefined, '<p>Your sign-in link</p>']) {
    const input = { ...message(), ...(html ? { html } : {}) };
    assert.deepEqual(await sender.send(input), { provider: 'rer', status: 'accepted', providerMessageId: null });
    const request = edge.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.ok(request.headers.authorization === `Bearer ${configuration.apiKey}`);
    assert.deepEqual(request.body, { to: 'reader@example.test', subject: input.subject, text: input.text, ...(html ? { html } : {}) });
  }
  assert.equal(edge.requests.length, 2);
});

test('relay errors preserve delivery policy without retrying or exposing the key', async t => {
  const configuration = config(), edge = await relay(t, configuration);
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const sender = createMailSender(configuration, { fetch: edge.fetch });
  const outcomes = [[400, 'rejected'], [401, 'rejected'], [402, 'rejected'], [403, 'rejected'], [413, 'rejected'],
    [429, 'rate_limited'], [502, 'uncertain'], [503, 'uncertain'], [408, 'uncertain'], [200, 'uncertain'], [204, 'uncertain']];
  for (const [status, expected] of outcomes) {
    edge.respond(status);
    const before = edge.requests.length;
    const result = await sender.send(message());
    assert.equal(result.status, expected, `HTTP ${status}`);
    assert.equal(result.providerMessageId, null);
    assert.equal(edge.requests.length, before + 1);
    assert.ok(!JSON.stringify(result).includes(configuration.apiKey));
  }
  const result = await createMailSender(configuration, { fetch() { throw Error(configuration.apiKey); } }).send(message());
  assert.equal(result.status, 'uncertain');
  assert.ok(!JSON.stringify(result).includes(configuration.apiKey));
  assert.ok(!JSON.stringify(logs).includes(configuration.apiKey));
});

test('the public sender never follows a relay redirect', async t => {
  const configuration = config(), edge = await relay(t, configuration);
  const sender = createMailSender(configuration, { fetch: edge.fetch });
  for (const status of [301, 302, 303, 307, 308]) {
    edge.respond(status);
    const before = edge.requests.length;
    const result = await sender.send(message());
    assert.equal(result.status, 'uncertain');
    assert.equal(result.code, 'transport_uncertain');
    assert.equal(edge.requests.length, before + 1);
  }
  assert.ok(edge.requests.every(request => request.path === '/api/managed-mail/send'));
});

test('unsupported relay messages and invalid credentials fail before network effects', async () => {
  let calls = 0;
  const dependencies = { fetch: async () => { calls++; return new Response(null, { status: 202 }); } };
  const configuration = config();
  const sender = createMailSender(configuration, dependencies);
  for (const change of [
    { to: ['first@example.test', 'second@example.test'] }, { subject: '' }, { subject: 'Sign in\nInjected' }, { subject: 'x'.repeat(201) },
    { text: undefined, html: '<p>HTML alone</p>' }, { text: 'x'.repeat(65_537) }, { html: 'x'.repeat(65_537) },
    { text: '界'.repeat(50_000) }, { cc: [] }, { bcc: [] }, { replyTo: 'reply@example.test' }, { headers: { 'Message-ID': '<sign-in@example.test>' } }, { attachments: [] },
    { unsubscribe: { url: 'https://app.example.test/unsubscribe' } }, { customArgs: {} }, { subscriptionTracking: false },
  ]) await assert.rejects(sender.send({ ...message(), ...change }), MailValidationError);
  for (const change of [
    { apiKey: undefined }, { apiKey: configuration.apiKey + '\n' }, { relayUrl: undefined },
    { relayUrl: 'http://managed.example.test/api/managed-mail/send' },
    { relayUrl: 'https://user:password@managed.example.test/send' },
  ]) assert.throws(() => createMailSender({ ...configuration, ...change }, dependencies), error =>
    error instanceof MailValidationError && !error.message.includes(configuration.apiKey));
  assert.equal(calls, 0);
});
