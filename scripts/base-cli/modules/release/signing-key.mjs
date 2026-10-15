import { createPublicKey, sign } from 'node:crypto';
import { b64, canonicalBytes, pae, keyIdFor, ENROLMENT_TYPE } from './signature.mjs';

export const timestamp = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
export function validity(now = new Date()) {
  const start = new Date(timestamp(now)), end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 2);
  return { notBefore: timestamp(start), notAfter: timestamp(end) };
}
export function envelope(privateKey, keyId, type, claim) {
  const payload = canonicalBytes(claim);
  return { payloadType: type, payload: b64(payload), signatures: [{ keyid: keyId, sig: b64(sign(null, pae(type, payload), privateKey)) }] };
}
export async function publicEntry(privateKey, { scope, publisher, githubOwner, notBefore, notAfter, unsignedThrough = {}, issuedAt = timestamp(new Date()) }) {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  const keyId = await keyIdFor(scope, raw), publicKey = b64(raw);
  const claim = { schemaVersion: 1, keyId, publicKey, publisher, githubOwner, notBefore, notAfter, issuedAt, unsignedThrough };
  return { keyId, publicKey, publisher, githubOwner, notBefore, notAfter, status: 'active',
    enrolment: envelope(privateKey, keyId, ENROLMENT_TYPE, claim), review: 'pending' };
}
export const anchorSet = (entry, scope) => ({ schemaVersion: 1, environment: scope === 'test' ? 'test' : 'production', serial: 1, legacyUnsigned: {}, keys: [entry] });
