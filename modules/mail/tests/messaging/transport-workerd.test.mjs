import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { config, message, source, NOW } from './fixtures.mjs';

test('public send/reconcile/erase facade signs in workerd over HTTP and service binding edges', async () => {
  const path = await mkdtemp(join(tmpdir(), 'messaging-transport-'));
  let runtime;
  try {
    runtime = await createRuntime(path, source(), NOW);
    for (const binding of [false, true]) {
      const response = await runtime.dispatchFetch('https://app.example.test/send', { method: 'POST', body: JSON.stringify({ config: config(), message: message(), binding }, (_key, value) => value instanceof Uint8Array ? [...value] : value) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value));
      assert.equal(value.result.status, 'accepted'); assert.equal(value.reconciliation.result.status, 'accepted'); assert.equal(value.erased.erased, true);
      assert.deepEqual(value.seen.map(request => request.method), ['POST', 'GET', 'POST']);
      assert.equal(value.seen[0].body.to, message().to[0]);
      assert.deepEqual(Buffer.from(value.seen[0].body.attachments[0].content, 'base64'), Buffer.from(message().attachments[0].content));
      assert.equal(value.seen[1].body, null); assert.equal(value.seen[1].path, `/v1/messages/${encodeURIComponent(message().deliveryId)}`);
      assert.deepEqual(value.seen[2].body, { address: 'Reader@example.test' });
    }
  } finally { await runtime?.dispose(); await rm(path, { recursive: true, force: true }); }
});
