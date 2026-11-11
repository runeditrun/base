import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { seconds, signJws } from '../modules/agent-door/conformance/crypto.mjs';
import { RerError } from './errors.mjs';
import { HOSTED_ORIGIN } from './hosted-output.mjs';
import { verificationBindings } from './agent-bindings.mjs';

// The verification owner of a disposable hosted installation: the keys and token its claim is signed or
// presented with, the bindings that make the installation accept them, the bootstrap request (or the seed's own
// verification.owner initializer) and the check that it ended in a 303 with a session cookie. Agent-door
// conformance and `rer size` both sign the owner in this way.

// Unpairing re-serves the installation without the Business trust it was paired with.
export const pairedBindings = ['RER_OWNER_CLAIM_ISSUER', 'RER_OWNER_CLAIM_INSTALLATION_ID', 'RER_OWNER_CLAIM_APP_ORIGIN', 'RER_OWNER_CLAIM_PUBLIC_KEYS', 'RER_BUSINESS_TRUST'];

/** A fresh token and claim key ring for one installation, and the seed's native owner bindings generated from them. */
export async function ownerKeys(root, native, { email, sub }) {
 const token = randomBytes(32).toString('hex'), kid = randomUUID(), installationId = randomUUID();
 const business = 'rer-agent-conformance';
 const issuer = `https://synthetic-base-1-${randomUUID()}.invalid`;
 const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
 const publicKeys = { [kid]: { kty, crv, x, y, kid, alg: 'ES256', use: 'sig' } };
 const values = { issuer, installationId, appOrigin: HOSTED_ORIGIN, publicKeys: JSON.stringify(publicKeys), email, sub, token, sessionSecret: randomBytes(32).toString('hex') };
 const nativeBindings = await verificationBindings(root, native.bindings, values);
 return { token, kid, installationId, business, issuer, pair, publicKeys, nativeBindings };
}

/** The bindings serveHosted gets so the installation accepts the owner claim. */
export const ownerBindings = ({ issuer, installationId, publicKeys, token, nativeBindings }, { claim, native, email }) => ({
 RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
 RER_OWNER_CLAIM_APP_ORIGIN: HOSTED_ORIGIN,
 RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(publicKeys),
 RER_BUSINESS_TRUST: JSON.stringify({ v: 1, issuer, audience: HOSTED_ORIGIN, subject: installationId, email, keys: publicKeys }),
 OWNER_EMAIL: email, SETUP_TOKEN: token,
 ...(claim?.emailField ? { [claim.emailField]: email } : {}),
 ...(claim?.tokenField ? { [claim.tokenField]: token } : {}),
 ...(native.emailField ? { [native.emailField]: email } : {}),
 ...(native.tokenField ? { [native.tokenField]: token } : {}),
 ...nativeBindings,
});

/** A request to a declared hosted origin: refuses another origin or credentials in the URL, times out at 30 s. */
export const hostedRequest = hosted => (absolute, init = {}) => {
 const url = new URL(absolute);
 if (url.username || url.password || !hosted.origins.includes(url.origin)) throw new RerError('agent_door_origin', 'Agent conformance request must use a declared hosted installation origin.', 1);
 const timeout = AbortSignal.timeout(30_000);
 return hosted.fetch(url.href.slice(url.origin.length + 1), { ...init, origin: url.origin, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, headers: Object.fromEntries(new Headers(init.headers)) });
};

/** Where the owner claim is presented, and what is presented: a signed claim for the signed mode, else the setup token. */
export async function ownerClaim({ claim, owner, hosted, keys, email }) {
 const { token, kid, installationId, issuer, pair } = keys;
 const path = claim?.mode === 'signed' ? claim.path ?? '/auth/owner-claim' : owner?.path ?? claim?.path ?? '/auth/bootstrap';
 const issued = seconds();
 const claimToken = claim?.mode === 'signed' ? await signJws(pair.privateKey, kid, 'rer-owner-claim+jwt', {
  v: 1, iss: issuer, aud: hosted.origin, installationId, email, jti: randomUUID(), iat: issued, exp: issued + 300,
 }) : token;
 return { path, claimToken };
}

/** The bootstrap: the seed's native owner initializer, else the claim POSTed to the claim path. `extra` carries the
 * caller's own initializer arguments (agent-door adds its reviewers, mail and fixtures). */
export function bootstrapOwner({ hosted, request, native, claim, owner, keys, email, sub, path, claimToken, extra = {} }) {
 return native.initialize ? native.initialize({ request, origin: hosted.origin, email, sub,
  ...extra,
  displayName: 'Synthetic Base 1', label: native.label, database: hosted.database, token: keys.token, claim: { mode: claim?.mode ?? 'setup-token', path, token: claimToken }, returnTo: owner?.returnTo ?? '/',
 }) : request(new URL(path, hosted.origin).href, { method: 'POST', redirect: 'manual',
  headers: { Origin: hosted.origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: claimToken, displayName: 'Synthetic Base 1', returnTo: owner?.returnTo ?? '/' }),
 });
}

/** What the owner initializer gets as `reviewers`: it signs the declared native reviewers in with the owner's session. */
export const reviewerDoor = (reviewers, { request, hosted, owner }) => Object.freeze({
 initialize: (label, session) => reviewers.initialize(label, session, { request, origin: hosted.origin, returnTo: owner?.returnTo ?? '/' }),
});

/** The owner's session cookie from the bootstrap response, or why it is not a session: the bootstrap must end in a
 * 303 that was not followed and sets a cookie. */
export async function ownerSession(bootstrap) {
 const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
 await bootstrap.body?.cancel();
 if (bootstrap.status !== 303 || bootstrap.redirected || !cookie) return { cookie, failure: `Native owner bootstrap returned HTTP ${bootstrap.status}${!cookie ? ' without a session cookie' : ''}.` };
 return { cookie };
}
