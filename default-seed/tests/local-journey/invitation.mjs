import assert from 'node:assert/strict'

// Use the live rer dev HTTP door and the real invitation screen. The browser's
// request client shares its key cookie, exactly as the one-click action does.
export async function invitedPerson(page, runtime) {
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Alex Morgan')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('alex@example.test')
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
  const action = page.getByRole('link', { name: 'Sign in as Alex Morgan', exact: true })
  await action.waitFor()
  const href = await action.getAttribute('href')
  assert.ok(href.startsWith('/auth/one-click?'))
  const ownerCookies = await page.context().cookies()
  const signin = await page.request.get(`${runtime.origin}/signin?returnTo=/app`)
  const html = await signin.text()
  assert.ok(html.includes('Alex Morgan'))
  assert.doesNotMatch(html, /outbox|<form[^>]+action="\/auth\/magic-link"/i)
  const entered = await page.request.get(runtime.origin + href, { maxRedirects: 0 })
  assert.equal(entered.status(), 303)
  assert.equal(entered.headers().location, '/app')
  const session = await (await page.request.get(`${runtime.origin}/auth/session`)).json()
  assert.equal(session.operator.email, 'alex@example.test')
  assert.equal(session.operator.role, 'member')
  assert.equal(session.operator.status, 'active')
  assert.equal(session.kind, 'dev')
  await page.goto(`${runtime.origin}/app`)
  await page.getByText('alex@example.test · member', { exact: true }).waitFor()
  assert.equal((await page.request.get(`${runtime.origin}/__dev/outbox`)).status(), 404)
  const output = await runtime.command(['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--command', 'SELECT count(*) AS n FROM rer_mail_development_outbox', '--json'])
  assert.equal(JSON.parse(output)[0].results[0].n, 0, 'local mail is suppressed without retention')
  assert.equal(runtime.vars.MAIL_PROVIDER, 'development', 'no production mail transport is configured')
  const outputLines = (await runtime.command(['rer', 'dev', '--as', 'alex@example.test', '--json'])).split('\n')
  const ready = outputLines.filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(event => event.event === 'ready')
  assert.equal(ready.signedInAs, 'alex@example.test', 'rer also prints the invited person\'s one-click entry')
  await page.goto(ready.openUrl)
  try { await page.waitForURL('**/app') }
  catch { throw new Error(`Invited-person RER_OPEN stopped at ${new URL(page.url()).pathname}: ${await page.locator('body').innerText()}`) }
  await page.getByText('alex@example.test · member', { exact: true }).waitFor()
  await page.context().clearCookies()
  await page.context().addCookies(ownerCookies)
  await page.goto(`${runtime.origin}/app`)
  await page.getByText(`${runtime.vars.OWNER_EMAIL} · owner`, { exact: true }).waitFor()
}
