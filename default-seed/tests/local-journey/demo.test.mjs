import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
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
/** Every file of the checkout's own local state (SQLite's -shm and -wal too), by name and content hash. */
async function ownerState(root) {
  const directory = join(root, '.wrangler/state')
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
  return Promise.all(files.map(async (file) => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))
}

test('rer demo opens signed in on throwaway seeded data, sends nothing, and leaves the checkout untouched', { timeout: 30 * 60_000 }, async () => {
  const owner = 'demo-owner@example.test'
  const runtime = await freshLocalProject(owner)
  let demo, redirector
  try {
    await runtime.stop()
    const before = await ownerState(runtime.root)
    // A route that fetches a URL the way seeds do, following redirects by default.
    const server = join(runtime.root, 'src/server.ts'), source = await readFile(server, 'utf8')
    const entry = 'async fetch(request, bindings: Bindings, execution): Promise<Response> {'
    assert.ok(source.includes(entry))
    await writeFile(server, source.replace(entry, `${entry}\n    if (new URL(request.url).pathname === '/__follow') return fetch(new URL(request.url).searchParams.get('url')!).then((response) => new Response(String(response.status)), (error) => new Response(String(error)))`))
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

    // A loopback responder cannot pass a demo's request on to another host.
    redirector = createServer((request, response) => response.writeHead(302, { location: 'http://redirected.example.com/hop' }).end())
    await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    const followed = await (await fetch(`${demo.url}/__follow?url=${encodeURIComponent(`http://127.0.0.1:${redirector.address().port}/start`)}`)).text()
    assert.match(followed, /fetch failed/, 'the redirect to another host is refused')

    const bar = /<aside id="rer-demo-bar"[\s\S]*?<\/aside>/.exec(await app.page('/app'))[0]
    assert.match(bar, /GET auth\.example\.com/, 'the refused send is listed')
    assert.match(bar, /GET redirected\.example\.com/, 'the refused redirect hop is listed')
    assert.match(bar, /→ demo-owner@example\.test/, 'the step-up mail is listed as captured')

    await runtime.command(['rer', 'demo', '--stop'])
    demo.stopped = true
    await assert.rejects(readdir(demo.demo.state), { code: 'ENOENT' }, 'stopping deletes the demo data')
    assert.deepEqual(await ownerState(runtime.root), before, "the checkout's own state is untouched, byte for byte")
  } finally {
    redirector?.close()
    try { if (demo && !demo.stopped) await runtime.command(['rer', 'demo', '--stop']) } finally { await runtime.close() }
  }
})
