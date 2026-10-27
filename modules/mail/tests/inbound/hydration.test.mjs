import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResendAttachmentFetcher, normalizeInbound } from '../../src/inbound/index.mjs';
import { resend, limits, attachment } from './fixtures.mjs';
const apiKey = 'test-only-key';
const now = Date.parse('2026-10-06T12:00:00Z');
function runFetch(overrides = {}, response = () => new Response(attachment)) {
  const calls = [];
  const input = resend(); const metadata = { ...input.email.attachments[0], download_url: 'https://inbound-cdn.resend.com/email-1/attachments/attachment-1?signature=test', expires_at: '2026-10-06T12:01:00Z', ...overrides };
  const fetchAttachment = createResendAttachmentFetcher({ apiKey, maxAttachmentBytes: 100 }, { clock: () => now, fetch: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? Response.json(metadata) : response();
  } });
  return { input: { ...input, fetchAttachment }, calls };
}
test("inbound hydration binds fixed API identity to safe exact attachment downloads", async t => {
  const foldedCases = [];
foldedCases.push(['real hydration protocol uses fixed API, identity-bound CDN and no download credentials', async () => {
  const { input, calls } = runFetch();
  const result = await normalizeInbound(input, limits);
  assert.deepEqual(result.attachments[0].content, attachment);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.resend.com/emails/receiving/email-1/attachments/attachment-1');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(calls[1].init.headers, undefined);
  assert.ok(calls.every(call => call.init.redirect === 'manual'));
}]);
foldedCases.push(['unsafe CDN targets, userinfo, paths, expiry and mismatched metadata never download', async (t) => {
  await runCases(t, Array.from([
    { download_url: 'http://127.0.0.1/private' }, { download_url: 'https://api.resend.com/private' },
    { download_url: 'https://inbound-cdn.resend.com.evil.test/email-1/attachments/attachment-1' },
    { download_url: 'https://secret@inbound-cdn.resend.com/email-1/attachments/attachment-1' },
    { download_url: 'https://inbound-cdn.resend.com/email-2/attachments/attachment-1' },
    { expires_at: '2026-10-06T12:00:00Z' }, { id: 'other-id' }, { size: 7 }, { filename: 'another.png' },
  ], (overrides, rowIndex) => [`${t.name}: overrides row ${rowIndex + 1}`, async t => {
    const { input, calls } = runFetch(overrides);
    await assert.rejects(normalizeInbound(input, limits), { name: 'MailValidationError' });
    assert.equal(calls.length, 1);
}]));
}]);
foldedCases.push(['redirects and mismatched/over-limit download bytes fail without following', async (t) => {
  await runCases(t, Array.from([
    () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    () => new Response(new Uint8Array(7)), () => new Response(new Uint8Array(5)),
    () => new Response(attachment, { headers: { 'content-length': '7' } }),
  ], (response, rowIndex) => [`${t.name}: response row ${rowIndex + 1}`, async t => {
    const { input, calls } = runFetch({}, response);
    await assert.rejects(normalizeInbound(input, limits), { name: 'MailValidationError' });
    assert.equal(calls.length, 2);
}]));
}]);
foldedCases.push(['API redirect refuses credentials forwarding and transport errors are redacted', async (t) => {
  await runCases(t, Array.from([() => new Response(null, { status: 307, headers: { location: 'https://example.test/' } }), () => { throw new Error('SECRET'); }], (response, rowIndex) => [`${t.name}: response row ${rowIndex + 1}`, async t => {
    let calls = 0;
    const input = resend({ fetchAttachment: createResendAttachmentFetcher({ apiKey, maxAttachmentBytes: 100 }, { fetch: async () => { calls++; return response(); } }) });
    await assert.rejects(normalizeInbound(input, limits), error => error.code === 'inbound_attachment_fetch_failed' && !error.message.includes('SECRET'));
    assert.equal(calls, 1);
}]));
}]);
  await runCases(t, foldedCases);
});
