import { runCases } from '../helpers/cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { verifyWebhook, MAX_WEBHOOK_BYTES } from '../../src/events/index.mjs';
import { signed, NOW, encoder } from './fixtures.mjs';

test("signed webhook verification binds exact bytes, identity, time and trusted keys", async t => {
  const foldedCases = [];
for (const provider of ['sendgrid', 'resend']) {
  foldedCases.push([`${provider}: genuine signature covers arbitrary raw bytes including multipart`, async (t) => {
    const binary = Buffer.concat([Buffer.from('--boundary\r\nContent-Disposition: form-data; name="email"\r\n\r\nUnicode café\r\n'), Buffer.from([0, 255, 128]), Buffer.from('\r\n--boundary--\r\n')]);
    const input = signed(provider, binary);
    assert.equal(await verifyWebhook(input), true);
    await runCases(t, Array.from([0, 10, binary.length - 1], (index, rowIndex) => [`${t.name}: index row ${rowIndex + 1}`, async t => {
      const rawBody = new Uint8Array(input.rawBody); rawBody[index] ^= 1;
      assert.equal(await verifyWebhook({ ...input, rawBody }), false);
}]));
    assert.equal(await verifyWebhook({ ...input, rawBody: input.rawBody.slice(1) }), false);
    assert.equal(await verifyWebhook({ ...input, headers: new Headers() }), false);
  }]);
  foldedCases.push([`${provider}: inclusive clock boundary, stale/future and invalid time fail closed`, async (t) => {
    const input = signed(provider, '{}');
    await runCases(t, Array.from([-300_000, 300_000], (offset, rowIndex) => [`${t.name}: offset row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook({ ...input, now: NOW + offset }), true);
}]));
    await runCases(t, Array.from([-300_001, 300_001], (offset, rowIndex) => [`${t.name}: offset row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook({ ...input, now: NOW + offset }), false);
}]));
    await runCases(t, Array.from([NaN, Infinity, -1, NOW + 0.5], (now, rowIndex) => [`${t.name}: now row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook({ ...input, now }), false);
}]));
    await runCases(t, Array.from([-1, Infinity, 3601, 0.5], (toleranceSeconds, rowIndex) => [`${t.name}: toleranceSeconds row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook({ ...input, toleranceSeconds }), false);
}]));
    assert.equal(await verifyWebhook({ ...input, toleranceSeconds: 0 }), true);
    assert.equal(await verifyWebhook({ ...input, now: NOW + 1, toleranceSeconds: 0 }), false);
    await runCases(t, Array.from(['01790000000', '+1790000000', '1790000000.0', '1790000000,1790000000'], (timestamp, rowIndex) => [`${t.name}: timestamp row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook(signed(provider, '{}', { timestamp })), false);
}]));
  }]);
  foldedCases.push([`${provider}: bad key, encoding, signature and size rejection`, async (t) => {
    const input = signed(provider, '{}');
    await runCases(t, Array.from(['', 'not a key', input.key + '\n', input.key + '=', null], (key, rowIndex) => [`${t.name}: key row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook({ ...input, key }), false);
}]));
    const header = provider === 'sendgrid' ? 'x-twilio-email-event-webhook-signature' : 'svix-signature';
    await runCases(t, Array.from(['%%%', '', 'AA==', 'v1,AA==', input.headers.get(header) + ','], (signature, rowIndex) => [`${t.name}: signature row ${rowIndex + 1}`, async t => {
      const headers = new Headers(input.headers); headers.set(header, signature);
      assert.equal(await verifyWebhook({ ...input, headers }), false);
}]));
    assert.equal(await verifyWebhook({ ...input, rawBody: new Uint8Array(MAX_WEBHOOK_BYTES + 1) }), false);
    assert.equal(await verifyWebhook({ ...input, rawBody: '{}' }), false);
  }]);
}
foldedCases.push(['SendGrid rejects wrong key, P-384, negative/nonminimal DER, P1363 and trailing ASN.1', async (t) => {
  const input = signed('sendgrid', '{}');
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  await runCases(t, Array.from([other, p384], (pair, rowIndex) => [`${t.name}: pair row ${rowIndex + 1}`, async t => {
assert.equal(await verifyWebhook({ ...input, key: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }), false);
}]));
  const signature = Buffer.from(input.headers.get('x-twilio-email-event-webhook-signature'), 'base64');
  const negative = Buffer.from(signature); negative[4] |= 128;
  const nonminimal = Buffer.concat([signature.subarray(0, 4), Buffer.from([0]), signature.subarray(4)]); nonminimal[1]++; nonminimal[3]++;
  await runCases(t, Array.from([negative, nonminimal, Buffer.concat([signature, Buffer.from([0])]), randomBytes(64), Buffer.from([48, 6, 2, 1, 0, 2, 1, 1])], (bytes, rowIndex) => [`${t.name}: bytes row ${rowIndex + 1}`, async t => {
    const headers = new Headers(input.headers); headers.set('x-twilio-email-event-webhook-signature', bytes.toString('base64'));
    assert.equal(await verifyWebhook({ ...input, headers }), false);
}]));
  assert.equal(await verifyWebhook({ ...input, key: Buffer.concat([Buffer.from(input.key, 'base64'), Buffer.from([0])]).toString('base64') }), false);
}]);
foldedCases.push(['Resend verifies rotation signatures and binds Svix identity and timestamp', async () => {
  const input = signed('resend', '{}');
  const headers = new Headers(input.headers);
  headers.set('svix-signature', `v1,${randomBytes(32).toString('base64')} ${headers.get('svix-signature')}`);
  assert.equal(await verifyWebhook({ ...input, headers }), true);
  headers.set('svix-id', 'other'); assert.equal(await verifyWebhook({ ...input, headers }), false);
  const changedTime = new Headers(input.headers); changedTime.set('svix-timestamp', String(NOW / 1000 - 1));
  assert.equal(await verifyWebhook({ ...input, headers: changedTime }), false);
  assert.equal(await verifyWebhook({ ...input, key: `whsec_${randomBytes(32).toString('base64')}` }), false);
  assert.equal(await verifyWebhook({ ...input, key: `whsec_${Buffer.from('short').toString('base64')}` }), false);
  const malformed = new Headers(input.headers); malformed.set('svix-signature', `${malformed.get('svix-signature')} invalid`);
  assert.equal(await verifyWebhook({ ...input, headers: malformed }), false);
  // Non-zero padding bits must not alias a valid MAC.
  const signature = input.headers.get('svix-signature');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const position = signature.length - 2;
  const aliased = signature.slice(0, position) + alphabet[alphabet.indexOf(signature[position]) + 1] + '=';
  const aliases = new Headers(input.headers); aliases.set('svix-signature', aliased);
  assert.equal(await verifyWebhook({ ...input, headers: aliases }), false);
}]);
foldedCases.push(['published Svix interoperability vector', async () => {
  // The key is Svix's published example: its base64 body is kept apart from the
  // provider prefix so the copied test holds no literal credential-shaped value.
  const publishedExampleBody = 'plJ3nmyCDGBKInavdOK15jsl';
  assert.equal(await verifyWebhook({ provider: 'resend', rawBody: encoder.encode('{"event_type":"ping","data":{"success":true}}'), key: `whsec_${publishedExampleBody}`, now: 1731705121000,
    headers: new Headers({ 'svix-id': 'msg_loFOjxBNrRLzqYUf', 'svix-timestamp': '1731705121', 'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' }) }), true);
}]);
foldedCases.push(['raw body is snapshotted before asynchronous crypto', async () => {
  const input = signed('resend', '{}');
  const verification = verifyWebhook(input); input.rawBody.fill(0);
  assert.equal(await verification, true);
}]);
foldedCases.push(['exact raw-byte limit succeeds, unsupported provider and invalid input fail closed', async () => {
  assert.equal(await verifyWebhook(signed('resend', new Uint8Array(MAX_WEBHOOK_BYTES))), true);
  assert.equal(await verifyWebhook(undefined), false);
  assert.equal(await verifyWebhook({ ...signed('resend', '{}'), provider: 'cloudflare' }), false);
}]);
  await runCases(t, foldedCases);
});
