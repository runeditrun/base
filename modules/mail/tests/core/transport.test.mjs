import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestProvider, classifyHttpStatus, safeProviderMessageId, sendResult } from '../../src/core/transport.mjs';

test("one provider attempt preserves redirect safety and conservative result evidence", async t => {
  const foldedCases = [];
foldedCases.push(['status classification conservatively preserves ambiguous attempts', async (t) => {
  await runCases(t, Array.from([0, 101, 301, 302, 307, 308, 408, 500, 503], (status, rowIndex) => [`${t.name}: status ${status} row ${rowIndex + 1}`, async t => {
assert.equal(classifyHttpStatus(status), 'uncertain');
}]));
  await runCases(t, Array.from([400, 401, 403, 404, 409, 422], (status, rowIndex) => [`${t.name}: status ${status} row ${rowIndex + 1}`, async t => {
assert.equal(classifyHttpStatus(status), 'rejected');
}]));
  assert.equal(classifyHttpStatus(429), 'rate_limited');
  await runCases(t, Array.from([200, 202, 204], (status, rowIndex) => [`${t.name}: status ${status} row ${rowIndex + 1}`, async t => {
assert.equal(classifyHttpStatus(status), null);
}]));
}]);
foldedCases.push(['one request forces manual redirects and an abort signal', async () => {
  let calls = 0;
  const response = new Response(null, { status: 302, headers: { location: 'https://untrusted.example' } });
  const result = await requestProvider('https://api.example.test/send', { method: 'POST', body: '{}', redirect: 'follow' }, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.example.test/send');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    return response;
  } });
  assert.equal(result, response);
  assert.equal(calls, 1);
}]);
foldedCases.push(['network failures and malformed transports reveal no secrets or synthetic receipt', async (t) => {
  let calls = 0;
  await runCases(t, [
    ["throwing transport result: case 1", async t => {
      assert.equal(await requestProvider('https://api.example.test/send', {}, { fetch() { calls++; throw new Error('SENSITIVE key and body'); } }), null);
    }],
    ["throwing transport result: case 2", async t => {
      assert.equal(calls, 1);
    }]
  ]);
  await runCases(t, [
    ["malformed transport result: case 1", async t => {
      assert.equal(await requestProvider('https://api.example.test/send', {}, { fetch: async () => ({ status: 202 }) }), null);
    }]
  ]);
  await runCases(t, Array.from([null, undefined, '', ' \t', 'id\r\ninjected', 'x'.repeat(1025)], (input, rowIndex) => [`${t.name}: input row ${rowIndex + 1}`, async t => {
assert.equal(safeProviderMessageId(input), null);
}]));
  await runCases(t, [
    ["safe result inputs: case 1", async t => {
      assert.equal(safeProviderMessageId(' real-id '), 'real-id');
    }],
    ["safe result inputs: case 2", async t => {
      assert.deepEqual(sendResult('sendgrid', 'uncertain', null, 'transport_uncertain'), { provider: 'sendgrid', status: 'uncertain', providerMessageId: null, code: 'transport_uncertain' });
    }]
  ]);
}]);
  await runCases(t, foldedCases);
});
