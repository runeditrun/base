import assert from 'node:assert/strict'
import AxeBuilder from '@axe-core/playwright'
import { writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function journey(browser, runtime, width, owner) {
  const context = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await context.newPage()
  const errors = [], unexpectedNetwork = [], surfaces = []
  page.on('pageerror', () => errors.push('pageerror'))
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== runtime.origin) {
      unexpectedNetwork.push('external request')
      await route.abort()
    } else await route.continue()
  })
  async function audit(name) {
    const results = await new AxeBuilder({ page }).analyze()
    const severe = results.violations.filter(({ impact }) => ['serious', 'critical'].includes(impact))
    assert.deepEqual(severe.map(({ id, impact }) => ({ id, impact })), [], `${name}: axe serious/critical`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: no horizontal overflow`)
    surfaces.push(name)
  }
  try {
    // The outbox answers only behind the checkout's key gate: trade the key the
    // way RER_OPEN does, through the fragment and the same-origin exchange.
    await page.goto(`${runtime.origin}/__dev/key#rer-dev=${runtime.vars.RER_DEV_KEY}&next=/signin`)
    await page.waitForURL((url) => url.pathname === '/signin')
    assert.equal(page.url().includes(runtime.vars.RER_DEV_KEY), false, 'the key leaves the address bar')
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByRole('heading', { name: 'Set up the first owner' }).count(), 0, 'setup has already claimed the real first owner')
    assert.equal((await page.content()).includes(runtime.vars.SETUP_TOKEN), false, 'setup credential is not serialized into the document')
    assert.equal((await page.content()).includes(runtime.vars.SESSION_SECRET), false, 'session credential is not serialized into the document')
    await audit('first-owner sign-in')
    await page.getByRole('link', { name: 'development outbox' }).click()
    await page.getByRole('link', { name: 'Read message', exact: true }).first().click()
    await page.getByRole('link', { name: 'Open this link', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.waitForURL('**/setup')
    await audit('first-run owner confirmation')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
    await page.waitForURL('**/app')
    await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
    await audit('first-owner signed in')
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.waitForURL((url) => url.pathname === '/signin')
    assert.equal(await page.getByRole('heading', { name: 'Set up the first owner' }).count(), 0)
    await audit('signed out')
    const clear = join(runtime.root, '.wrangler', 'empty-outbox.sql')
    await writeFile(clear, 'DELETE FROM rer_mail_development_outbox;', { mode: 0o600 })
    await runtime.command(['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--persist-to', '.wrangler/state', '--config', 'dist/server/wrangler.json', '--file', clear])
    await page.getByRole('link', { name: 'development outbox' }).click()
    await page.getByText('No messages yet.').waitFor()
    await audit('empty outbox')
    await page.goto(`${runtime.origin}/signin`, { waitUntil: 'networkidle' })
    await page.getByLabel('Email', { exact: true }).fill(owner)
    await page.getByRole('button', { name: 'Email a sign-in link' }).click()
    await page.getByRole('status').filter({ hasText: 'If this address' }).waitFor()
    await audit('link requested')
    // A fresh process must read the captured mail from D1 rather than memory.
    await runtime.stop()
    const varsPath = join(runtime.root, '.dev.vars')
    const preserved = (await readFile(varsPath, 'utf8')).replace(/^SETUP_TOKEN=.*\n/m, '') + '# retained after claiming owner\nLOCAL_JOURNEY_EXTRA=preserved\n'
    await writeFile(varsPath, preserved)
    const setup = await runtime.rerunSetup()
    assert.equal(await readFile(varsPath, 'utf8'), preserved, 'rerun preserves exact credentials and removed setup token')
    assert.match(setup, /Checking the existing owner through ordinary sign-in/)
    assert.doesNotMatch(setup, /Use Set up the first owner/)
    await runtime.assertDist()
    await runtime.start(runtime.origin)
    await page.getByRole('link', { name: 'development outbox' }).click()
    await page.getByRole('heading', { name: 'Development outbox', exact: true }).waitFor()
    await audit('persisted outbox list')
    await page.getByRole('link', { name: 'Read message', exact: true }).first().click()
    const detailPath = new URL(page.url()).pathname + new URL(page.url()).search
    await page.getByRole('link', { name: 'Open this link', exact: true }).waitFor()
    await audit('persisted outbox detail')
    await page.getByRole('link', { name: 'Open this link', exact: true }).click()
    await page.getByRole('heading', { name: 'Confirm sign-in' }).waitFor()
    await audit('confirm sign-in')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.waitForURL('**/app')
    await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
    await audit('magic-link signed in')
    await page.goto(`${runtime.origin}${detailPath}`, { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Open this link', exact: true }).click()
    await page.getByText('This link is invalid or expired').waitFor()
    await audit('consumed link')
    await injectionProof(page, runtime, audit)
    for (const file of await readdir(join(runtime.root, 'dist/client/assets'))) {
      const source = await readFile(join(runtime.root, 'dist/client/assets', file), 'utf8')
      for (const secret of [runtime.vars.SETUP_TOKEN, runtime.vars.SESSION_SECRET]) {
        assert.equal(source.includes(secret), false, 'emitted browser asset excludes generated credentials')
      }
      for (const forbidden of ['SESSION_SECRET', 'SETUP_TOKEN', 'MAIL_API_KEY', 'cloudflare:workers']) {
        assert.equal(source.includes(forbidden), false, 'server-only binding names stay out of client assets')
      }
    }
    await runtime.assertDist()
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpectedNetwork, [])
    return { width, surfaces, seriousOrCritical: 0, horizontalOverflow: 0, persistedAcrossRestart: true, externalBrowserRequests: 0, readme: runtime.readme }
  } finally { await context.close() }
}

async function injectionProof(page, runtime, audit) {
  const subject = '<img src=x onerror="window.outboxInjected=true"> Injection proof'
  const text = `<script>window.outboxInjected=true</script>\n${runtime.origin}/auth/confirm?token=${'long-local-link-'.repeat(120)}`
  const message = { from: 'auth@localhost.test', to: ['owner@example.test'], subject, text, html: '<svg onload="window.outboxInjected=true"></svg>' }
  const sql = `INSERT INTO rer_mail_development_outbox(id, created_at, message) VALUES ('journey-injection', ${Date.now()}, '${JSON.stringify(message).replaceAll("'", "''")}');`
  const fixture = join(runtime.root, '.wrangler', 'journey-injection.sql')
  await writeFile(fixture, sql, { mode: 0o600 })
  await runtime.command(['exec', 'wrangler', 'd1', 'execute', 'default-seed-reference', '--local', '--persist-to', '.wrangler/state', '--config', 'dist/server/wrangler.json', '--file', fixture])
  await page.goto(`${runtime.origin}/__dev/outbox`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: subject, exact: true }).waitFor()
  assert.equal(await page.locator('img, svg, script').count(), 0, 'subject HTML is inert')
  await audit('injection outbox list')
  await page.goto(`${runtime.origin}/__dev/outbox?message=journey-injection`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: subject, exact: true }).waitFor()
  assert.equal(await page.locator('pre').textContent(), text)
  assert.equal(await page.locator('img, svg, script').count(), 0, 'message HTML is inert')
  assert.equal(await page.evaluate(() => window.outboxInjected), undefined)
  await audit('injection and long-link outbox detail')
}
