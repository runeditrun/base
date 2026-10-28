// The owner's own email-link step-up through the native routes, confirmed in
// the signed-in session that returns to the agent's handoff. Test tooling only:
// it reads this run's disposable mail, never a credential the door could see.
export default async function prove({ request, origin, email, cookie, handoff, mail }) {
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }
  const asked = await request(new URL('/auth/step-up', origin).href, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify({ action: 'export', returnTo: new URL(handoff.url).pathname }) })
  await asked.body?.cancel()
  if (asked.status !== 202) throw new Error(`Native step-up returned HTTP ${asked.status}`)
  const link = /https:\/\/\S+\/auth\/confirm\?token=\S+/.exec(mail.latest(email) ?? '')?.[0]
  if (!link) throw new Error('Native step-up sent no confirmation link')
  const confirmed = await request(new URL('/auth/confirm', origin).href, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify({ token: new URL(link).searchParams.get('token') }) })
  await confirmed.body?.cancel()
  if (confirmed.status !== 303) throw new Error(`Native step-up confirmation returned HTTP ${confirmed.status}`)
}
