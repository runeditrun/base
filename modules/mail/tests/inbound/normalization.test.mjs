import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInbound } from '../../src/inbound/index.mjs';
import { cloudflare, mimeFixture, sendgrid, resend, expected, limits, form, plain, rich, attachment } from './fixtures.mjs';
const encoder = new TextEncoder();
const failure = (input, constraints = limits, code) => assert.rejects(normalizeInbound(input, constraints), error => error.name === 'MailValidationError' && (!code || error.code === code) && !/SECRET/.test(error.message));
test("inbound adapters normalize complete original mail and refuse malformed partial messages", async t => {
  const foldedCases = [];
await runCases(t, Array.from(Object.entries({ cloudflare, sendgrid, resend }), ([provider, fixture], rowIndex) => [`${t.name}: [provider, fixture] row ${rowIndex + 1}`, async t => {
  foldedCases.push([`${provider} normalizes equivalent Unicode threaded multipart and binary inline mail`, async () => {
    assert.deepEqual(await normalizeInbound(fixture(), limits), { provider, ...expected });
  }]);
  foldedCases.push([`${provider} enforces body, individual and total attachment exact boundaries`, async (t) => {
    const bodyBytes = encoder.encode(plain).length + encoder.encode(rich).length;
    await normalizeInbound(fixture(), { ...limits, maxBodyBytes: bodyBytes, maxAttachmentBytes: attachment.length, maxTotalAttachmentBytes: attachment.length, maxAttachments: 1 });
    await runCases(t, [
    ["attachment and body boundaries: case 1", async t => {
      await failure(fixture(), { ...limits, maxBodyBytes: bodyBytes - 1 }, 'inbound_body_limit');
    }],
    ["attachment and body boundaries: case 2", async t => {
      await failure(fixture(), { ...limits, maxAttachmentBytes: attachment.length - 1 }, 'inbound_attachment_limit');
    }],
    ["attachment and body boundaries: case 3", async t => {
      await failure(fixture(), { ...limits, maxTotalAttachmentBytes: attachment.length - 1 }, 'inbound_attachments_limit');
    }]
  ]);
  }]);
}]));
foldedCases.push(['raw boundary success, false size claims and actual streaming overflow', async (t) => {
  const raw = mimeFixture();
  await normalizeInbound(cloudflare(raw), { ...limits, maxRawBytes: raw.length });
  await runCases(t, [
    ["raw MIME boundaries: case 1", async t => {
      await failure(cloudflare(raw), { ...limits, maxRawBytes: raw.length - 1 }, 'inbound_raw_limit');
    }],
    ["raw MIME boundaries: case 2", async t => {
      await failure(cloudflare(raw, 1), { ...limits, maxRawBytes: raw.length - 1 }, 'inbound_raw_limit');
    }],
    ["raw MIME boundaries: case 3", async t => {
      await failure(cloudflare(raw, raw.length - 1), limits, 'inbound_raw_size_mismatch');
    }]
  ]);
  const sg = sendgrid();
  await normalizeInbound(sg, { ...limits, maxRawBytes: sg.rawBody.length });
  await runCases(t, [['SendGrid raw byte overflow', async t => {
  await failure(sg, { ...limits, maxRawBytes: sg.rawBody.length - 1 }, 'inbound_raw_limit');
  }]]);
  const rs = resend(); const jsonBytes = encoder.encode(JSON.stringify(rs.email)).length;
  await normalizeInbound(rs, { ...limits, maxRawBytes: jsonBytes });
  await runCases(t, [['Resend raw byte overflow', async t => {
  await failure(rs, { ...limits, maxRawBytes: jsonBytes - 1 }, 'inbound_raw_limit');
  }]]);
}]);
foldedCases.push(['empty subject and missing optional headers remain explicit', async (t) => {
  const raw = encoder.encode('From: sender@example.test\r\nTo: receiver@example.test\r\nSubject:\r\n\r\nhello');
  const sg = form([['from', 'sender@example.test'], ['to', 'receiver@example.test'], ['subject', ''], ['text', 'hello']]);
  const rs = resend({ email: { id: 'email-1', from: 'sender@example.test', to: ['receiver@example.test'], subject: '', text: 'hello', attachments: [] } });
  await runCases(t, Array.from([cloudflare(raw), sg, rs], (input, rowIndex) => [`${t.name}: input row ${rowIndex + 1}`, async t => {
assert.deepEqual(await normalizeInbound(input, limits), {
    provider: input.provider, messageId: null, from: 'sender@example.test', to: ['receiver@example.test'], subject: '', text: 'hello', html: null, inReplyTo: null, references: [], attachments: [],
  });
}]));
}]);
foldedCases.push(['SendGrid raw MIME mode parses original bytes', async () => {
  const parsed = await normalizeInbound(form([['email', mimeFixture()]]), limits);
  assert.deepEqual(parsed, { provider: 'sendgrid', ...expected });
}]);
foldedCases.push(['SendGrid rejects duplicate fields, omitted files, count conflicts and malformed metadata', async (t) => {
  await runCases(t, [
    ["SendGrid malformed metadata: case 1", async t => {
      await failure(sendgrid([['from', 'SECRET']]));
    }],
    ["SendGrid malformed metadata: case 2", async t => {
      await failure(form([['from', 'sender@example.test'], ['to', 'receiver@example.test'], ['text', 'x'], ['attachments', '1']]));
    }],
    ["SendGrid malformed metadata: case 3", async t => {
      await failure(sendgrid([['content-ids', '{bad']]));
    }]
  ]);
  const mismatch = sendgrid(); mismatch.rawBody = encoder.encode(new TextDecoder().decode(mismatch.rawBody).replace('"content-id":"logo"', '"content-id":"other"'));
  await failure(mismatch, limits, 'inbound_attachment_metadata_mismatch');
}]);
foldedCases.push(['malformed MIME, encoded words, multipart and canonical base64 fail atomically', async (t) => {
  const original = new TextDecoder().decode(mimeFixture());
  await runCases(t, Array.from([
    original.replace('--mixed+1--', '--missing--'), original.replace('AAF/gMj/', '!!!!'), original.replace('AAF/gMj/', 'AB=='),
    original.replace('caf=C3=A9', 'caf=ZZ'), original.replace('boundary="mixed+1"', 'boundary="unterminated'),
    original.replace('Message-ID: <new@example.test>', 'Message-ID: <new@example.test>\r\nMessage-ID: <other@example.test>'),
    original.replace('=?UTF-8?B?Q2Fmw6k=?=', '=?UTF-8?B?!!!?='), 'not an email',
  ], (source, rowIndex) => [`malformed MIME input row ${rowIndex + 1}`, async t => {
await failure(cloudflare(encoder.encode(source)));
}]));
  const sg = sendgrid(); sg.rawBody = sg.rawBody.slice(0, -22); await failure(sg);
}]);
foldedCases.push(['Resend binds signed identity and validates all metadata before hydration', async (t) => {
  let calls = 0; const fixture = resend({ fetchAttachment: async () => { calls++; return attachment; } });
  await runCases(t, [
    ["Resend identity inputs: case 1", async t => {
      await failure({ ...fixture, signedEmailId: 'other-email' }, limits, 'inbound_identity_mismatch');
    }],
    ["Resend identity inputs: case 2", async t => {
      await failure({ ...fixture, signedEmailId: undefined }, limits, 'invalid_inbound_provider_id');
    }]
  ]);
  fixture.email.attachments.push({ ...fixture.email.attachments[0] });
  await failure(fixture, limits, 'duplicate_inbound_attachment');
  assert.equal(calls, 0);
}]);
foldedCases.push(['Resend does not drop unhydrated attachments and rejects false bytes and callback errors', async (t) => {
  await runCases(t, [
    ["Resend hydration failures: case 1", async t => {
      await failure(resend({ fetchAttachment: undefined }), limits, 'inbound_attachment_fetch_required');
    }],
    ["Resend hydration failures: case 2", async t => {
      await failure(resend({ fetchAttachment: async () => new Uint8Array(5) }), limits, 'inbound_attachment_size_mismatch');
    }],
    ["Resend hydration failures: case 3", async t => {
      await failure(resend({ fetchAttachment: async () => new Uint8Array(101) }), limits, 'inbound_attachment_limit');
    }],
    ["Resend hydration failures: case 4", async t => {
      await failure(resend({ fetchAttachment: async () => { throw new Error('SECRET provider key'); } }), limits, 'invalid_inbound');
    }]
  ]);
  const input = resend({ fetchAttachment: async item => { assert.equal(Object.isFrozen(item), true); assert.equal(item.emailId, 'email-1'); assert.equal(item.download_url, undefined); return attachment; } });
  input.email.attachments[0].download_url = 'http://127.0.0.1/SECRET';
  await normalizeInbound(input, limits);
}]);
foldedCases.push(['stream cancellation and redaction on failure', async () => {
  let cancelled = false;
  const input = cloudflare(); input.message.rawSize = 1;
  input.message.raw = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; } });
  await failure(input, { ...limits, maxRawBytes: 10 }, 'inbound_raw_limit');
  assert.equal(cancelled, true);
}]);
  await runCases(t, foldedCases);
});
