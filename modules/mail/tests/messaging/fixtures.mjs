import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const NOW = 1_790_000_000_000;
export const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const signingKey = pair.privateKey.export({ format: 'jwk' });
export const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'event-current' };
export const config = () => ({ provider: 'messaging', mode: 'test', serviceOrigin: 'https://messaging.example.test', installId: 'app-install', kid: 'app-current', signingKey: structuredClone(signingKey) });
export const source = () => ({ serviceOrigin: 'https://messaging.example.test', installId: 'app-install', jwks: { keys: [structuredClone(publicJwk)] } });
export const message = (deliveryId = 'command/with space?and#界') => ({ deliveryId, kind: 'transactional', from: 'Équipe <sender@example.test>', to: ['Reader <Reader@example.test>'], subject: 'Your message', text: 'Hello 界',
  expiresAt: new Date(NOW + 100_000).toISOString(), attachments: [{ filename: '图.bin', contentType: 'application/octet-stream', content: Uint8Array.of(0, 255, 128, 10) }] });
export const accepted = () => ({ provider: 'messaging', status: 'accepted', providerMessageId: 'message-service-1' });
export const event = (id = 'event-1', extra = {}) => ({ id, messageId: 'message-service-1', deliveryId: 'command-1', recipient: 'Reader@example.test', occurredAt: new Date(NOW).toISOString(), type: 'delivered', detail: {}, ...extra });
export function signedEvents(events, { claims = {}, header = {}, privateKey = pair.privateKey } = {}) {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: publicJwk.kid, typ: 'JWT', ...header })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: source().serviceOrigin, aud: source().installId, iat: NOW / 1000, events, ...claims })).toString('base64url');
  return `${head}.${payload}.${sign('sha256', Buffer.from(`${head}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
// Independent verifier at the only doubled boundary: the Messaging HTTP API.
export function verifyRequest(url, init) {
  const [header, payload, signature] = new Headers(init.headers).get('RER-Signature').split('.');
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, 'app-current');
  const bytes = Buffer.from(init.body ?? []);
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: config().installId, aud: new URL(url).origin, iat: NOW / 1000, method: init.method, path: new URL(url).pathname,
    bodySha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(init.redirect, 'manual');
  return bytes;
}
