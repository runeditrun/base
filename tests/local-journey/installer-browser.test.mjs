import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { startInstaller } from '../../scripts/base-onboarding/server.mjs'
import { createSeed } from '../../scripts/installer/seed.mjs'

// The reference adapter and manifest, with test-only setup inputs to exercise
// shared browser capabilities absent from the reference's magic-link setup.
test('reference installer routes manifest artwork, refuses unsafe origins and offers to save new secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reference-installer-browser-'))
  let browser, installer
  try {
    const manifest = JSON.parse(await readFile(new URL('../../rer-setup.json', import.meta.url)))
    manifest.groups.unshift({ id: 'workspace', label: 'Workspace' })
    manifest.fields.unshift(
      { name: 'TEAM_TITLE', label: 'Team', kind: 'text', required: true, group: 'workspace' },
      { name: 'CHAT_SITE', label: 'Website', kind: 'url', required: true, group: 'workspace' },
      { name: 'ACCENT', label: 'Colour', kind: 'colour', required: true, group: 'workspace' },
      { name: 'HELP_SITE', label: 'Help website', kind: 'url', group: 'workspace' },
      { name: 'PRIVATE_SITE', label: 'Conditional website', kind: 'url', required: true, group: 'workspace', when: { field: 'TEAM_TITLE', equals: 'Hidden team' } },
    )
    manifest.fields.push({ name: 'NEW_SECRET', label: 'New secret', kind: 'secret', input: 'entered', ownerVisible: true, required: true, group: 'owner' })
    await writeFile(join(root, 'rer-setup.json'), JSON.stringify(manifest))
    await cp(new URL('../../scripts/installer/ui', import.meta.url), join(root, 'scripts/installer/ui'), { recursive: true })
    // The descriptor's declared theme and the font and logo files it names.
    await cp(new URL('../../public', import.meta.url), join(root, 'public'), { recursive: true })
    const presentation = join(root, 'scripts/installer/ui/seed.mjs')
    await writeFile(presentation, (await readFile(presentation, 'utf8')).replace('artwork: false', 'artwork: true'))
    installer = await startInstaller(root, { seed: createSeed(), noPrefill: true })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage(), errors = [], art = [], effects = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/\/api\/(start|connect)$/.test(request.url())) effects.push(request.url()) })
    // Artwork generation is the paid network edge; no model is called.
    await page.route('**/api/workspace-art', async route => {
      art.push({ ...installer.state.draft })
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    const response = await page.request.get(installer.origin)
    const token = (await response.text()).match(/name="installer-token" content="([a-f0-9]+)"/)[1]
    const headers = { Origin: installer.origin, 'X-Installer-Token': token }
    const post = (path, data) => page.request.post(installer.origin + path, { headers, data })
    await page.goto(installer.origin)
    await page.locator('#TEAM_TITLE').waitFor()
    assert.equal((await post('/api/activity', { phase: 'checking', topic: 'setup' })).status(), 200)
    await page.waitForFunction(() => document.querySelector('#activity')?.dataset.phase === 'checking')
    // Make the origin the only missing/invalid input in this step.
    for (const [key, value] of Object.entries({ TEAM_TITLE: 'First team', ACCENT: '#123456' })) {
      await page.locator('#' + key).fill(value)
      await page.locator('#heading').click()
    }
    const unsafe = ['https://user:private@example.test', 'https://example.test?token=private', 'https://example.test#private', 'https://example.test?', 'https://example.test#']
    for (const value of unsafe) {
      for (const path of ['/api/prefill', '/api/draft']) assert.equal((await post(path, { CHAT_SITE: value })).status(), 400)
      await page.locator('#CHAT_SITE').fill(value)
      await page.locator('#heading').click()
      assert.equal(await page.locator('#continue').isDisabled(), true)
      assert.ok(!JSON.stringify(installer.state).includes(value))
    }
    for (const [key, value] of Object.entries({ TEAM_TITLE: 'First team', CHAT_SITE: 'example.test/path', ACCENT: '#123456' })) {
      await page.locator('#' + key).fill(value)
      await page.locator('#heading').click()
    }
    await page.waitForFunction(() => document.querySelector('#CHAT_SITE')?.value === 'https://example.test')
    await assertEventually(() => art.length === 1)
    assert.equal(art[0].TEAM_TITLE, 'First team', 'answers are saved before artwork is requested')
    assert.equal(art[0].CHAT_SITE, 'https://example.test')
    assert.equal(art[0].ACCENT, '#123456')
    for (const [key, value] of Object.entries({ TEAM_TITLE: 'Next team', CHAT_SITE: 'https://next.example.test', ACCENT: '#654321' })) {
      const count = art.length
      await page.locator('#' + key).fill(value)
      await page.locator('#heading').click()
      await assertEventually(() => art.length === count + 1)
      assert.equal(art.at(-1)[key], value)
      await page.locator('#' + key).focus(); await page.locator('#heading').click()
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(art.length, count + 1, 'unchanged commits do not queue artwork')
    }
    await page.locator('#continue').click()
    await page.locator('#NEW_SECRET').waitFor()
    assert.equal(await page.locator('#NEW_SECRET').getAttribute('type'), 'password')
    assert.equal(await page.locator('#NEW_SECRET').getAttribute('autocomplete'), 'new-password')
    assert.deepEqual(errors, []); assert.deepEqual(effects, [])
  } finally {
    try { await browser?.close() } finally {
      try { await installer?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})

async function assertEventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('Expected installer effect did not arrive')
}
