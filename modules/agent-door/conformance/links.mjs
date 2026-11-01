import { decisionSchema } from './business.mjs';
import { schemaErrors } from './schema.mjs';

// BASE-AGENT-015 helpers for a seed's link journey. Business composes links from
// custody and a reference only; these build them exactly as the schema states.
export const OPEN_PATH = '/app/open';
export const recordLink = (origin, uri) => `${origin}${OPEN_PATH}?resource=${encodeURIComponent(uri)}`;
export const auditLink = (origin, id) => `${origin}${OPEN_PATH}?audit=${id}`;
export const linkShaped = (kind, link) => schemaErrors({ ...decisionSchema.$defs[kind === 'audit' ? 'auditLink' : 'recordLink'], $defs: decisionSchema.$defs }, link).length === 0;

/** References the destination must refuse without a redirect, signed in or out. */
export function malformedLinks(uri, auditId) {
 const last = uri.lastIndexOf('/'), stem = uri.slice(0, last + 1);
 return [
  ['absolute', `${OPEN_PATH}?resource=${encodeURIComponent('https://elsewhere.invalid/app/people')}`],
  ['other-origin', `${OPEN_PATH}?resource=${encodeURIComponent('//elsewhere.invalid/app')}`],
  ['path', `${OPEN_PATH}?resource=${encodeURIComponent('/app/people')}`],
  ['encoded-traversal', `${OPEN_PATH}?resource=${encodeURIComponent(`${stem}%2e%2e%2fsetup`)}`],
  ['dot-segment', `${OPEN_PATH}?resource=${encodeURIComponent(`${stem}..`)}`],
  ['undeclared-type', `${OPEN_PATH}?resource=${encodeURIComponent('undeclared://record/1')}`],
  ['extra-parameter', `${OPEN_PATH}?resource=${encodeURIComponent(uri)}&next=${encodeURIComponent('https://elsewhere.invalid/')}`],
  ['repeated-parameter', `${OPEN_PATH}?audit=${auditId}&audit=${auditId}`],
  ['unknown-parameter', `${OPEN_PATH}?ref=${encodeURIComponent(uri)}`],
  ['malformed-audit', `${OPEN_PATH}?audit=${encodeURIComponent(`../${auditId}`)}`],
  ['bare', OPEN_PATH],
 ];
}

/** One answer, reduced to what a person or another site could observe. */
export async function observed(response) {
 return { status: response.status, location: response.headers.get('location'), cookie: response.headers.get('set-cookie'), body: await response.text() };
}

/** The signed-out answer: a 303 to the native sign-in that keeps exactly this link and sets nothing. */
export function keepsLink(answer, link, signIn = '/signin') {
 if (answer.status !== 303 || answer.cookie || !answer.location?.startsWith(`${signIn}?`)) return false;
 const back = new URL(answer.location, 'https://seed.invalid').searchParams.get('returnTo');
 const url = new URL(link, 'https://seed.invalid');
 return back === url.pathname + url.search;
}
