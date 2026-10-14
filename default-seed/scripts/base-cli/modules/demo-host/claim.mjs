// The signed owner claim (modules/owner-claim) a demo's front Worker makes for
// its container: one ES256 key pair per container, its public JWK given to the
// container at start, and one five-minute claim signed with the private key,
// which is never stored.
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const segment = value => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function claimKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const kid = crypto.randomUUID().replaceAll('-', '');
  return { kid, privateKey: pair.privateKey, publicKeys: { [kid]: { kty, crv, x, y, kid, alg: 'ES256', use: 'sig' } } };
}

/** The compact JWS /auth/owner-claim verifies: issuer and audience are the demo's own origin. */
export async function signClaim({ kid, privateKey }, { origin, installationId, email, now }) {
  const iat = Math.floor(now / 1000);
  const signed = `${segment({ alg: 'ES256', typ: 'rer-owner-claim+jwt', kid })}.${segment({ v: 1, iss: origin, aud: origin, installationId, email, jti: crypto.randomUUID(), iat, exp: iat + 300 })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signed));
  return `${signed}.${base64url(signature)}`;
}
