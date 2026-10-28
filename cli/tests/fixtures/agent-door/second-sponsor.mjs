// Consume only this fixture's captured native invitation. The actual account,
// session and membership are created by production auth and application doors.
export default async function initialize({ request, origin, email, database }) {
 const db = await database('DB');
 const mail = await db.prepare('SELECT body FROM fixture_mail WHERE email=? ORDER BY rowid DESC LIMIT 1').bind(email).first();
 const link = new URL(mail.body.match(/https:\/\/[^\s]+/)[0]);
 const response = await request(new URL('/auth/confirm', origin).href, { method: 'POST', redirect: 'manual',
  headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.searchParams.get('token') }),
 });
 if (response.status !== 303) throw new Error('Native invitation confirmation failed');
 const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
 const linked = await request(new URL('/app/membership/link', origin).href, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
 if (![200, 404].includes(linked.status)) throw new Error('Native membership failed');
 await linked.body?.cancel();
 return response;
}
