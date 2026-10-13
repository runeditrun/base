import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { freshLocalProject } from './runtime.mjs'

const decoded = (text) => text.replaceAll('&amp;', '&').replaceAll('&#39;', "'")
function client(origin, cookie) {
  const headers = { cookie }
  return {
    page: async (path) => decoded(await (await fetch(origin + path, { headers })).text()),
    post: async (path, body) => {
      const response = await fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { ...headers, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, json: await response.json().catch(() => null) }
    },
  }
}
/** Every row of the checkout's own local D1 files, as text. */
function ownerData(root) {
  const directory = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  return readdir(directory).then((files) => files.filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite').map((file) => {
    const db = new DatabaseSync(join(directory, file), { readOnly: true })
    try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => `${name}:${JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())}`).join('\n') } finally { db.close() }
  }).join('\n'))
}

test('rer demo opens signed in on throwaway seeded data, sends nothing, and leaves the checkout untouched', { timeout: 30 * 60_000 }, async () => {
  const owner = 'demo-owner@example.test'
  const runtime = await freshLocalProject(owner)
  let demo
  try {
    await runtime.stop()
    const before = await ownerData(runtime.root)
    const output = await runtime.command(['rer', 'demo', '--detach', '--json'])
    demo = output.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((event) => event.event === 'ready')
    assert.equal(demo.signedInAs, owner, 'the demo opens as the saved owner')
    assert.ok(demo.demo.state.startsWith(join(await realpath(runtime.root), '.rer/demo/')), 'the demo keeps its data in its own folder')
    assert.ok((await readdir(demo.demo.state)).length > 0)

    const entered = await fetch(`${demo.url}/auth/dev/enter?as=owner`, { redirect: 'manual', headers: { 'x-rer-dev-key': runtime.vars.RER_DEV_KEY } })
    assert.equal(entered.status, 303)
    const app = client(demo.url, entered.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).filter((cookie) => !cookie.endsWith('=')).join('; '))
    const dashboard = await app.page('/app')
    assert.match(dashboard, /id="rer-demo-bar"/, 'every page carries the Demo bar')
    assert.match(dashboard, /Latest job: (?:<!-- -->)?completed/, 'the seed demo data is in place and the owner lands in the app')
    assert.match(await app.page('/records'), /Worker boundaries/)

    // Linking an identity provider is the reference's outbound path: the
    // provider lookup is refused, and the bar lists it beside the captured mail.
    assert.equal((await app.post('/auth/step-up', { action: 'providers:relink', returnTo: '/app' })).status, 202)
    const outbox = await (await fetch(`${demo.url}/__dev/outbox`, { headers: { 'x-rer-dev-key': runtime.vars.RER_DEV_KEY } })).text()
    const message = decoded(await (await fetch(`${demo.url}/__dev/outbox?message=${/\?message=([^"&]+)"/.exec(outbox)[1]}`, { headers: { 'x-rer-dev-key': runtime.vars.RER_DEV_KEY } })).text())
    assert.equal((await app.post('/auth/confirm', { token: /token=([A-Za-z0-9_-]+)/.exec(message)[1] })).status, 303)
    assert.equal((await app.post('/auth/dependencies/relink', { issuer: 'https://auth.example.com' })).status, 200)
    const callback = await app.post('/.well-known/rer-link/callback', { issuer: 'https://auth.example.com', code: 'demo-code' })
    assert.equal(callback.status, 502, 'the provider lookup fails as a network failure')
    const bar = /<aside id="rer-demo-bar"[\s\S]*?<\/aside>/.exec(await app.page('/app'))[0]
    assert.match(bar, /GET auth\.example\.com/, 'the refused send is listed')
    assert.match(bar, /→ demo-owner@example\.test/, 'the step-up mail is listed as captured')

    await runtime.command(['rer', 'demo', '--stop'])
    demo.stopped = true
    await assert.rejects(readdir(demo.demo.state), { code: 'ENOENT' }, 'stopping deletes the demo data')
    assert.equal(await ownerData(runtime.root), before, "the checkout's own data is untouched")
  } finally {
    try { if (demo && !demo.stopped) await runtime.command(['rer', 'demo', '--stop']) } finally { await runtime.close() }
  }
})
