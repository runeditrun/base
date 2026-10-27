import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInbound } from '../../src/inbound/index.mjs';
import { cloudflare, mimeFixture, resend, limits, attachment, form } from './fixtures.mjs';
const encoder = new TextEncoder();
const full = new TextDecoder().decode(mimeFixture());
function twoAttachments(provider) {
  if (provider === 'cloudflare') return cloudflare(encoder.encode(full.replace('--mixed+1--', '--mixed+1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="second.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAF/gMj/\r\n--mixed+1--')));
  if (provider === 'resend') {
    const input = resend(); input.email.attachments.push({ ...input.email.attachments[0], id: 'attachment-2' }); return input;
  }
  return form([['from', 'sender@example.test'], ['to', 'receiver@example.test'], ['text', 'x'], ['attachments', '2']], [1, 2].map(i => ({ name: `attachment${i}`, filename: `${i}.bin`, type: 'application/octet-stream', content: attachment })));
}
test("inbound normalization preserves exact aggregate limits and rejects malformed encodings", async t => {
  const foldedCases = [];
for (const provider of ['cloudflare', 'resend', 'sendgrid']) foldedCases.push([`${provider} validates aggregate decoded bytes and attachment count across files`, async (t) => {
  const parsed = await normalizeInbound(twoAttachments(provider), { ...limits, maxAttachments: 2, maxAttachmentBytes: 6, maxTotalAttachmentBytes: 12 });
  assert.equal(parsed.attachments.length, 2);
  await runCases(t, [
    ["attachment limit inputs: case 1", async t => {
      await assert.rejects(normalizeInbound(twoAttachments(provider), { ...limits, maxTotalAttachmentBytes: 11 }), { code: 'inbound_attachments_limit' });
    }],
    ["attachment limit inputs: case 2", async t => {
      await assert.rejects(normalizeInbound(twoAttachments(provider), { ...limits, maxAttachments: 1 }), { code: 'inbound_attachment_count' });
    }]
  ]);
}]);
foldedCases.push(['MIME decodes legacy charset and counts resulting UTF-8 body bytes', async () => {
  const input = () => cloudflare(encoder.encode('From: sender@example.test\r\nTo: receiver@example.test\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9'));
  assert.equal((await normalizeInbound(input(), { ...limits, maxBodyBytes: 5 })).text, 'café');
  await assert.rejects(normalizeInbound(input(), { ...limits, maxBodyBytes: 4 }), { code: 'inbound_body_limit' });
}]);
foldedCases.push(['SendGrid uses declared original field charset and preserves multiple recipients', async () => {
  const input = form([['from', 'sender@example.test'], ['to', '"Doe, Jane" <jane@example.test>, =?UTF-8?Q?Doe=2C_Jos=C3=A9?= <jose@example.test>'], ['text', new Uint8Array([99, 97, 102, 233])], ['charsets', '{"text":"iso-8859-1"}']]);
  const actual = await normalizeInbound(input, limits);
  assert.equal(actual.text, 'café'); assert.deepEqual(actual.to, ['jane@example.test', 'jose@example.test']);
}]);
foldedCases.push(['binary attachment bytes containing boundary-like text remain intact', async () => {
  const bytes = encoder.encode('before\r\n--form-boundary-extra\r\nafter\0');
  const input = form([['from', 'sender@example.test'], ['to', 'receiver@example.test'], ['attachments', '1']], [{ name: 'attachment1', filename: 'binary.bin', type: 'application/octet-stream', content: bytes }]);
  assert.deepEqual((await normalizeInbound(input, limits)).attachments[0].content, bytes);
}]);
foldedCases.push(['RFC 2231 continued filename and missing attachment filename normalize without losing content', async t => {

  await runCases(t, [
['continued UTF-8 filename', async t => {
  const raw = full.replace("filename*=utf-8''caf%C3%A9.png", "filename*0*=utf-8''caf%C3; filename*1*=%A9.png");
  assert.equal((await normalizeInbound(cloudflare(encoder.encode(raw)), limits)).attachments[0].filename, 'café.png');
}],
['missing attachment filename', async t => {
  const unnamed = full.replace("Content-Disposition: inline; filename*=utf-8''caf%C3%A9.png\r\n", '');
  assert.equal((await normalizeInbound(cloudflare(encoder.encode(unnamed)), limits)).attachments[0].filename, '');
}]
  ]);
}]);
foldedCases.push(['invalid limits, UTF-8, unknown encoding and malformed folds fail closed', async (t) => {
  await runCases(t, Array.from([0, -1, 1.5, NaN, Infinity, undefined], (value, rowIndex) => [`${t.name}: value row ${rowIndex + 1}`, async t => {
await assert.rejects(normalizeInbound(resend(), { ...limits, maxRawBytes: value }), { code: 'invalid_inbound_limits' });
}]));
  await runCases(t, Array.from([
    full.replace('quoted-printable', 'unknown'), full.replace('caf=C3=A9', 'caf=FF'),
    full.replace('From:', ' From:'), full.replace('boundary=alternative', 'boundary=wrong'),
  ], (source, rowIndex) => [`${t.name}: source row ${rowIndex + 1}`, async t => {
await assert.rejects(normalizeInbound(cloudflare(encoder.encode(source)), limits), { name: 'MailValidationError' });
}]));
  await assert.rejects(normalizeInbound(cloudflare(encoder.encode(full.replace('<parent@example.test>\r\nRef', '<parent@example.test> stray\r\nRef'))), limits), { code: 'invalid_inbound_thread' });
  // A long run of header whitespace before a line separator is refused in linear time.
  const started = performance.now();
  await assert.rejects(normalizeInbound(cloudflare(encoder.encode(full.replace('From:', `X-Pad:${' '.repeat(90_000)}\u2028\r\nFrom:`))), limits), { code: 'invalid_inbound_headers' });
  assert.ok(performance.now() - started < 1000);
}]);
foldedCases.push(['a later hydration failure yields no successful partial message', async () => {
  let calls = 0;
  const input = twoAttachments('resend');
  input.fetchAttachment = async () => { if (++calls === 1) return attachment; throw new Error('secret provider error'); };
  await assert.rejects(normalizeInbound(input, limits), { code: 'invalid_inbound' });
  assert.equal(calls, 2);
}]);
foldedCases.push(['malformed raw bytes in quoted-printable and encoded words are rejected', async (t) => {
  await runCases(t, Array.from([full.replace('caf=C3=A9', 'café'), full.replace('=?UTF-8?B?Q2Fmw6k=?=', '=?UTF-8?Q?Ā?=')], (source, rowIndex) => [`${t.name}: source row ${rowIndex + 1}`, async t => {
    await assert.rejects(normalizeInbound(cloudflare(encoder.encode(source)), limits), { name: 'MailValidationError' });
}]));
  const input = resend(); input.email.from += '\r\n';
  await assert.rejects(normalizeInbound(input, limits), { code: 'invalid_inbound_header' });
}]);
  await runCases(t, foldedCases);
});
