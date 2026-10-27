import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailSender, MailValidationError } from '../../index.mjs';

const message = () => ({ deliveryId: 'dev-17', from: 'sender@example.com', to: ['reader@example.net'], subject: 'Hello', text: 'Plain body' });

test('development delivery suppresses app mail without storage or provider calls', async (t) => {
  await runCases(t, [['independent input groups', async t => {
  const sender = createMailSender({ provider: 'development', mode: 'development' }, {
    fetch() { assert.fail('development delivery contacted a provider'); },
    outbox: { put() { assert.fail('development delivery captured mail'); } },
  });
  assert.deepEqual(await sender.send(message()), { provider: 'development', status: 'development', providerMessageId: null });
  await runCases(t, [
    ["development refusal inputs: case 1", async t => {
      await assert.rejects(sender.send({ ...message(), to: ['invalid'] }), error => error instanceof MailValidationError && error.code === 'invalid_address');
    }],
    ["development refusal inputs: case 2", async t => {
      assert.throws(() => createMailSender({ provider: 'development', mode: 'production' }), error => error instanceof MailValidationError && error.code === 'development_mode_required');
    }]
  ]);

  }]]);
});
