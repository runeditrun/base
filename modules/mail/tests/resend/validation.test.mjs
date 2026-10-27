import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendResend } from '../../src/adapters/resend/index.mjs';
import { MailValidationError } from '../../src/core/errors.mjs';
import { config, message, providerFixture } from './fixtures.mjs';

async function refuses(input, expectedCode, settings = config) {
  const fixture = providerFixture();
  await assert.rejects(sendResend(settings, input, fixture), error => {
    assert.ok(error instanceof MailValidationError);
    if (expectedCode) assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes('SENSITIVE'), false);
    return true;
  });
  assert.equal(fixture.calls.length, 0);
}

test("Resend refuses unsafe or unsupported requests before transport", async t => {
  const foldedCases = [];
foldedCases.push(['standalone validation rejects missing credentials, mismatched providers and endpoint overrides', async (t) => {
  await runCases(t, [
    ["Resend configuration inputs: case 1", async t => {
      await refuses(message(), 'api_key_required', { provider: 'resend', mode: 'production' });
    }],
    ["Resend configuration inputs: case 2", async t => {
      await refuses(message(), 'invalid_provider', { ...config, provider: 'sendgrid' });
    }],
    ["Resend configuration inputs: case 3", async t => {
      await refuses(message(), 'invalid_config', { ...config, endpoint: 'https://untrusted.example' });
    }],
    ["Resend configuration inputs: case 4", async t => {
      await refuses(message(), 'invalid_mode', { ...config, mode: undefined });
    }],
    ["Resend configuration inputs: case 5", async t => {
      await refuses(message(), 'invalid_api_key', { ...config, apiKey: 'SENSITIVE\r\nInjected: x' });
    }]
  ]);
}]);
foldedCases.push(['unsupported requests cannot silently disappear before sending', async (t) => {
  await runCases(t, Array.from([{ customArgs: {} }, { asmGroupId: 1 }, { subscriptionTracking: false }], (field, rowIndex) => [`${t.name}: field row ${rowIndex + 1}`, async t => {
await refuses({ ...message(), ...field }, 'unsupported_provider_setting');
}]));
  await runCases(t, [
    ["Resend message inputs: case 1", async t => {
      await refuses({ ...message(), unsubscribe: { url: 'https://example.net/leave' } }, 'unsubscribe_requires_facade');
    }],
    ["Resend message inputs: case 2", async t => {
      await refuses({ ...message(), scheduledAt: '2030-01-01' }, 'invalid_message');
    }],
    ["Resend message inputs: case 3", async t => {
      await refuses({ ...message(), attachments: [{ filename: 'x', contentType: 'text/plain', content: new Uint8Array(), contentId: 'x', disposition: 'attachment' }] }, 'unsupported_resend_attachment_disposition');
    }],
    ["Resend message inputs: case 4", async t => {
      await refuses({ ...message(), attachments: [{ filename: 'x', contentType: 'text/plain', content: new Uint8Array(), disposition: 'inline' }] }, 'inline_content_id_required');
    }]
  ]);
}]);
foldedCases.push(['invalid idempotency keys and recipient limits fail before transport', async (t) => {
  await runCases(t, Array.from(['x'.repeat(257), '界', ' padded', 'padded ', 'bad\nkey', ''], (deliveryId, rowIndex) => [`${t.name}: deliveryId row ${rowIndex + 1}`, async t => {
await refuses({ ...message(), deliveryId });
}]));
  await runCases(t, [
    ["Resend recipient inputs: case 1", async t => {
      await refuses({ ...message(), to: Array.from({ length: 51 }, (_, i) => `r${i}@example.net`) }, 'resend_recipient_limit');
    }],
    ["Resend recipient inputs: case 2", async t => {
      await refuses({ ...message(), to: [] }, 'invalid_recipients');
    }]
  ]);
}]);
foldedCases.push(['injection, reserved headers and malformed attachment bytes fail closed', async (t) => {
  await runCases(t, Array.from(['from', 'replyTo'], (field, rowIndex) => [`${t.name}: field row ${rowIndex + 1}`, async t => {
await refuses({ ...message(), [field]: 'SENSITIVE@example.net\r\nBcc: victim@example.net' });
}]));
  await runCases(t, Array.from(['to', 'cc', 'bcc'], (field, rowIndex) => [`${t.name}: field row ${rowIndex + 1}`, async t => {
await refuses({ ...message(), [field]: ['SENSITIVE@example.net\nInjected:x'] });
}]));
  await runCases(t, Array.from([
    { 'X-Trace': 'SENSITIVE\r\nBcc:x' }, { 'Bad\nName': 'x' }, { To: 'victim@example.net' },
    { 'X-Trace': '1', 'x-trace': '2' }, { 'Resend-Idempotency-Key': 'other' }, { 'iDeMpOtEnCy-KeY': 'other' },
  ], (headers, rowIndex) => [`${t.name}: headers row ${rowIndex + 1}`, async t => {
await refuses({ ...message(), headers });
}]));
  await runCases(t, [
    ["Resend content inputs: case 1", async t => {
      await refuses({ ...message(), subject: 'SENSITIVE\r\nInjected:x' });
    }],
    ["Resend content inputs: case 2", async t => {
      await refuses({ ...message(), text: '', html: undefined }, 'body_required');
    }]
  ]);
  await runCases(t, Array.from([{ content: 'Zm9v' }, { contentType: 'text/plain\r\nInjected:x' }, { filename: 'SENSITIVE\nname' }, { path: 'https://untrusted.example' }, { disposition: 'inline', contentId: 'bad\nid' }], (extra, rowIndex) => [`${t.name}: extra row ${rowIndex + 1}`, async t => {
    await refuses({ ...message(), attachments: [{ filename: 'x.txt', contentType: 'text/plain', content: Uint8Array.of(1), ...extra }] });
}]));
}]);
foldedCases.push(['explicit remote configuration remains remote even in development mode', async () => {
  const fixture = providerFixture();
  let writes = 0;
  const result = await sendResend({ ...config, mode: 'development' }, message(), { fetch: fixture.fetch, outbox: { async put() { writes++; } } });
  assert.equal(result.status, 'accepted');
  assert.equal(fixture.calls.length, 1);
  assert.equal(writes, 0);
}]);
foldedCases.push(['every remaining unsubscribe property requires facade assembly', async (t) => {
  await runCases(t, Array.from([undefined, null, { url: 'http://example.net/unsafe' }], (unsubscribe, rowIndex) => [`${t.name}: unsubscribe row ${rowIndex + 1}`, async t => {
await refuses({ ...message(), unsubscribe }, 'unsubscribe_requires_facade');
}]));
}]);
  await runCases(t, foldedCases);
});
