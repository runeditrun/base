import assert from 'node:assert/strict'
import AxeBuilder from '@axe-core/playwright'
import { writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { invitedPerson } from './invitation.mjs'

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
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
    const results = await new AxeBuilder({ page }).analyze()
    const severe = results.violations.filter(({ impact }) => ['serious', 'critical'].includes(impact))
    assert.deepEqual(severe.map(({ id, impact }) => ({ id, impact })), [], `${name}: axe serious/critical`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: no horizontal overflow`)
    surfaces.push(name)
  }
  try {
    const open = () => page.goto(`${runtime.origin}/__dev/key#${new URLSearchParams({ 'rer-dev': runtime.vars.RER_DEV_KEY, as: 'owner', next: '/auth/dev/enter?as=owner&returnTo=/setup' })}`)
    await open()
    await page.waitForURL('**/setup')
    await audit('first-run owner confirmation')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
    await page.waitForURL('**/app')
    await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
    await audit('first-owner signed in')
    await invitedPerson(page, runtime)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.waitForURL((url) => url.pathname === '/signin')
    assert.equal(await page.getByRole('heading', { name: 'Set up the first owner' }).count(), 0)
    await audit('signed out')
    // The same one-click entry works after a complete server restart, with
    // settings and the durable owner's first-run completion preserved.
    await runtime.stop()
    const varsPath = join(runtime.root, '.dev.vars')
    const preserved = (await readFile(varsPath, 'utf8')).replace(/^SETUP_TOKEN=.*\n/m, '') + '# retained after claiming owner\nLOCAL_JOURNEY_EXTRA=preserved\n'
    await writeFile(varsPath, preserved)
    await runtime.rerunSetup()
    assert.equal(await readFile(varsPath, 'utf8'), preserved, 'rerun preserves exact credentials and removed setup token')
    await runtime.assertDist()
    await runtime.start(runtime.origin)
    await open()
    await page.waitForURL('**/app')
    await page.getByText(`${owner} · owner`, { exact: true }).waitFor()
    await audit('one-click owner entry after restart')
    const before = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('link', { name: 'Public record', exact: true }).click()
    await page.getByRole('heading', { name: 'Server-rendered public record' }).waitFor()
    assert.equal(await page.evaluate(() => performance.timeOrigin), before, 'client navigation stays hydrated')
    await audit('public record navigation')
    assert.equal((await page.request.get(`${runtime.origin}/__dev/outbox`)).status(), 404)
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
