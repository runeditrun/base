import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryEventIntake } from '../../src/events/index.mjs';
import { signed, resend, NOW, secret } from './fixtures.mjs';

const base = { provider: 'resend', key: secret, tenantId: 'tenant', eventNamespace: 'endpoint', clock: () => NOW };
test("delivery event intake admits effects only after authorized validated evidence", async t => {
  const foldedCases = [];
foldedCases.push(['configuration requires explicit durable storage and identity authorization', async (t) => {
  await runCases(t, [
    ["event configuration inputs: case 1", async t => {
      assert.throws(() => createDeliveryEventIntake(base), { code: 'invalid_event_config' });
    }],
    ["event configuration inputs: case 2", async t => {
      assert.throws(() => createDeliveryEventIntake({ ...base, authorize: () => true }), { code: 'event_storage_required' });
    }]
  ]);
}]);
foldedCases.push(['no storage operation before successful crypto, schema and authorization', async () => {
  let operations = 0, authorizations = 0;
  // Test-only sentinel: any attempt to persist is a failure for these inputs.
  const storage = { transaction() { operations++; throw new Error('unreachable test storage'); } };
  const intake = createDeliveryEventIntake({ ...base, storage, authorize() { authorizations++; return false; } });
  const input = signed('resend', JSON.stringify(resend()));
  input.rawBody[0] ^= 1;
  await runCases(t, [
    ['invalid signature stops before authorization', async t => {
  await assert.rejects(intake.ingestWebhook(input), { code: 'event_signature_invalid' });
  assert.equal(authorizations, 0);
    }],
    ['valid signature requires authorization', async t => {
  await assert.rejects(intake.ingestWebhook(signed('resend', JSON.stringify(resend()))), { code: 'event_unauthorized' });
  assert.equal(authorizations, 1); assert.equal(operations, 0);
    }],
  ]);
}]);
foldedCases.push(['storage and authorization dependency failures do not leak provider or secret text', async (t) => {
  const marker = 'sensitive sentinel from test dependency';
  const storage = { async transaction() { throw new Error(marker); } };
  await runCases(t, Array.from([() => true, () => { throw new Error(marker); }], (authorize, rowIndex) => [`${t.name}: authorize row ${rowIndex + 1}`, async t => {
    const intake = createDeliveryEventIntake({ ...base, storage, authorize });
    await assert.rejects(intake.ingestWebhook(signed('resend', JSON.stringify(resend()))), error => {
      assert.equal(error.message.includes(marker), false);
      assert.ok(['event_storage_failed', 'event_unauthorized'].includes(error.code));
      return true;
    });
}]));
}]);
foldedCases.push(['Cloudflare exposes only a queue entry, with no HTTP intake or signature mechanism', () => {
  const intake = createDeliveryEventIntake({ ...base, provider: 'cloudflare', key: undefined,
    authorize: () => true, storage: { transaction() { throw new Error('unused test sentinel'); } },
    cloudflareSource: { queue: 'events', accountId: 'account', zoneId: 'zone', domain: 'example.test', eventSubscriptionId: 'sub' } });
  assert.deepEqual(Object.keys(intake), ['consumeQueue']);
}]);
  await runCases(t, foldedCases);
});
