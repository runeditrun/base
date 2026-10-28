// Exercise the real operator-auth email proof and its one-use native token.
export async function confirmMail({ request, origin, email, returnTo = '/app', mail }) {
 const since = Date.now();
 const sent = await request(new URL('/auth/magic-link', origin).href, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, returnTo }) });
 if (!sent.ok) throw new Error('Native confirmation delivery failed');
 await sent.body?.cancel();
 const captured = mail.read({ after: since, limit: 1, maxAgeMs: 60_000 });
 const match = captured[0]?.text.match(/https:\/\/[^\s]+/);
 if (!match) throw new Error('Native confirmation mail unavailable');
 const link = new URL(match[0]);
 if (link.origin !== origin || link.pathname !== '/auth/confirm') throw new Error('Native confirmation link is invalid');
 const confirmed = await request(new URL(link.pathname, origin).href, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.searchParams.get('token') }) });
 if (confirmed.status !== 303 || !confirmed.headers.getSetCookie().length) throw new Error('Native confirmation did not issue a session');
 return confirmed;
}
