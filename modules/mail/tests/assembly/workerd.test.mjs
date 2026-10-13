import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, request } from './runtime.mjs';

test('doctor sends through the public facade and reads independent receipt evidence in workerd', async () => {
  const path = await mkdtemp(join(tmpdir(), 'mail-assembly-'));
  let runtime;
  try {
    runtime = await createRuntime(path);
    for (const provider of ['sendgrid', 'resend', 'cloudflare']) {
      const { result, calls } = await request(runtime, 'doctor', { provider });
      assert.deepEqual(result.items.slice(4).map(row => row.status), ['pass', 'pass']);
      assert.equal(result.items[5].evidence.source, 'resend_received_email_api');
      assert.equal(result.items[4].evidence.correlationId, result.items[5].evidence.correlationId);
      assert.equal(calls.filter(row => row.method === 'POST').length, 1);
      assert.equal(calls.filter(row => row.method === 'GET').length, 2);
    }
  } finally { await runtime?.dispose(); await rm(path, { recursive: true, force: true }); }
});
