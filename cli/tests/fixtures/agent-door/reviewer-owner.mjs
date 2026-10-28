import assert from 'node:assert/strict';
import initializeOwner from './initializer.mjs';

export default async function initialize(context) {
 const { request, origin, reviewers } = context;
 const bootstrap = await initializeOwner(context);
 const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
 const post = (body, session = cookie) => request(origin + '/app/review', { method: 'POST', redirect: 'manual',
  headers: { Origin: origin, Cookie: session, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 const prepared = await post({ action: 'prepare' });
 assert.equal(prepared.status, 200);
 const { id } = await prepared.json();
 const samePerson = await post({ action: 'sign', id });
 assert.equal(samePerson.status, 403);
 assert.equal((await samePerson.json()).error, 'independent_reviewer_required');
 const reviewer = await reviewers.initialize('quality', { cookie });
 const accepted = await post({ action: 'sign', id }, reviewer.cookie);
 assert.equal(accepted.status, 200);
 assert.equal((await accepted.json()).reviewed, true);
 // Having completed a reviewer lifecycle does not change the preparer's rights.
 const stillDenied = await post({ action: 'sign', id });
 assert.equal(stillDenied.status, 403);
 await stillDenied.body?.cancel();
 return bootstrap;
}
