// Native owner setup uses the same bootstrap and membership form routes as a
// person. No owner/session/database authority enters this module.
export default async function initialize({ request, origin, token, displayName, returnTo }) {
  const bootstrap = await request(new URL('/auth/bootstrap', origin).href, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, displayName, returnTo }),
  });
  if (bootstrap.status !== 303) throw new Error(`Native bootstrap returned HTTP ${bootstrap.status}`);
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  if (!cookie) throw new Error('Native bootstrap did not issue a session');
  const linked = await request(new URL('/app/membership/link', origin).href, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const result = await linked.json();
  if (!linked.ok || result.linked !== true) throw new Error(`Native membership returned HTTP ${linked.status}`);
  return bootstrap;
}
