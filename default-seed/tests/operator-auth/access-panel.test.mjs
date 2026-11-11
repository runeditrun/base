import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

// The real access panel, bundled as the app builds it and run in Chromium. Only the
// network edge is faked: the page's own origin and the /auth answers it fetches.
const panel = fileURLToPath(new URL('../../src/core/features/auth/access.tsx', import.meta.url))
const source = `import { createRoot } from 'react-dom/client'; import { OperatorAccess } from ${JSON.stringify(panel)}; createRoot(document.getElementById('root')).render(<OperatorAccess />)`
const { outputFiles: [bundle] } = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })

async function invited(origin, answer) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.route(`${origin}/**`, route => {
      const { pathname } = new URL(route.request().url())
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="root"></div><script>${bundle.text.replaceAll('</script', '<\\/script')}</script>` })
      if (pathname === '/auth/session') return route.fulfill({ json: { id: 's', kind: 'native', operator: { id: 'o', email: 'owner@example.test', displayName: 'Owner', role: 'owner', status: 'active' } } })
      if (pathname === '/auth/operators' || pathname === '/auth/sessions') return route.fulfill({ json: [] })
      if (pathname === '/auth/invite') return route.fulfill({ status: 202, json: answer })
      return route.fulfill({ status: 404, json: { error: 'not_found' } })
    })
    await page.goto(`${origin}/`)
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Priya')
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('priya@example.test')
    await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
    await page.getByRole('status').waitFor()
    return (await page.locator('.auth-panel').innerText())
  } finally { await browser.close() }
}

test('a local run says nothing was sent and how to sign in on this computer', async () => {
  const text = await invited('http://127.0.0.1:8787', { status: 'accepted', delivery: 'none', signInUrl: '/auth/one-click?as=priya%40example.test' })
  assert.match(text, /No email was sent/)
  assert.match(text, /priya@example\.test can sign in on this computer/)
  assert.match(text, /rer dev --as priya@example\.test/)
  assert.match(await invited('http://admin.localhost:8787', { status: 'accepted', delivery: 'none' }), /rer dev --as priya@example\.test/)
})

test('a hosted demo that sent nothing does not show the local-only text', async () => {
  const text = await invited('https://demo.example.test', { status: 'accepted', delivery: 'none' })
  assert.match(text, /No email was sent/)
  assert.doesNotMatch(text, /this computer|rer dev|mail provider/)
  // A delivered invitation is unchanged anywhere.
  assert.match(await invited('https://app.example.test', { status: 'accepted' }), /Invitation sent\./)
})
