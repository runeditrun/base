import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { join } from 'node:path'
import { freshLocalProject } from './runtime.mjs'

const decoded = (text) => text.replaceAll('&amp;', '&').replaceAll('&#39;', "'")
function client(origin, cookie) {
  const headers = { cookie }
  return {
    page: async (path) => decoded(await (await fetch(origin + path, { headers })).text()),

  }
}
/** Every file of the checkout's own local state (SQLite's -shm and -wal too), by name and content hash. */
async function ownerState(root) {
  const directory = join(root, '.wrangler/state')
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
  return Promise.all(files.map(async (file) => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))
}

test('rer demo opens signed in on throwaway seeded data and leaves the checkout untouched', { timeout: 30 * 60_000 }, async () => {
  const owner = 'demo-owner@example.test'
  const runtime = await freshLocalProject(owner)
  let demo
  try {
    await runtime.stop()
    const before = await ownerState(runtime.root)
    const output = await runtime.command(['rer', 'demo', '--detach', '--json'])
    demo = output.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((event) => event.event === 'ready')
    assert.equal(demo.signedInAs, owner, 'the demo opens as the saved owner')
    assert.ok(demo.demo.state.startsWith(join(await realpath(runtime.root), '.rer/demo/')), 'the demo keeps its data in its own folder')
    assert.ok((await readdir(demo.demo.state)).length > 0)

    const entered = await fetch(`${demo.url}/auth/local/cli-session`, { method: 'POST', redirect: 'manual', headers: { origin: demo.url, 'content-type': 'application/json', 'x-rer-local-cli': createHmac('sha256', runtime.vars.SESSION_SECRET).update('local-cli\0sign-in').digest('hex') }, body: '{}' })
    assert.equal(entered.status, 303)
    const app = client(demo.url, entered.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).filter((cookie) => !cookie.endsWith('=')).join('; '))
    const dashboard = await app.page('/app')
    assert.match(dashboard, /Latest job: (?:<!-- -->)?completed/, 'the seed demo data is in place and the owner lands in the app')
    assert.match(await app.page('/records'), /Worker boundaries/)

    await runtime.command(['rer', 'demo', '--stop'])
    demo.stopped = true
    await assert.rejects(readdir(demo.demo.state), { code: 'ENOENT' }, 'stopping deletes the demo data')
    assert.deepEqual(await ownerState(runtime.root), before, "the checkout's own state is untouched, byte for byte")
  } finally {
    try { if (demo && !demo.stopped) await runtime.command(['rer', 'demo', '--stop']) } finally { await runtime.close() }
  }
})
