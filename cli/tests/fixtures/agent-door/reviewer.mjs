import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

/** Seed-owned invitation and confirmation, with the real independent session. */
export default async function initialize({ request, origin, email, owner, mail }) {
 const post = (path, body, cookie) => request(origin + path, { method: 'POST', redirect: 'manual',
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
 const invitation = await post('/auth/invite', { email, displayName: 'Independent reviewer', role: 'admin' }, owner.cookie);
 assert.equal(invitation.status, 202);
 await invitation.body?.cancel();
 const messages = mail.read({ limit: 1 });
 assert.equal(messages.length, 1);
 const link = new URL(messages[0].text.match(/https:\/\/[^\s]+/)[0]);
 assert.equal(link.origin, origin);
 const denied = await post('/auth/confirm', { token: randomBytes(32).toString('hex') });
 assert.equal(denied.status, 400);
 await denied.body?.cancel();
 const response = await post('/auth/confirm', { token: link.searchParams.get('token') });
 assert.equal(response.status, 303);
 const replay = await post('/auth/confirm', { token: link.searchParams.get('token') });
 assert.equal(replay.status, 400);
 await replay.body?.cancel();
 return response;
}
