import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './harness.mjs';

test('remote mail adapters send a binary attachment in actual workerd', async () => {
  const worker = await createWorker('tests/runtime/provider-worker.mjs', ['index.mjs', 'tests/runtime/provider-fixtures.mjs']);
  try {
    for (const provider of ['sendgrid', 'resend', 'cloudflare']) {
      const response = await worker.dispatchFetch(`https://mail.test/?provider=${provider}&scenario=accepted`);
      assert.equal(response.status, 200);
      const { result, calls, error } = await response.json();
      assert.equal(error, undefined);
      assert.equal(result.provider, provider); assert.equal(result.status, 'accepted');
      assert.equal(calls.length, 1); assert.equal(calls[0].body.attachments[0].content, 'AP+ACg==');
    }
  } finally { await worker.dispose(); }
});
