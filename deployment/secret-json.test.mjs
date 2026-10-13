import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readdirSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { withSecretJsonFile } from './secret-json.mjs'

const values = { SESSION_SECRET: ' test-only #value "quote" = value\nnext line ', UNICODE: 'a→b' }

test('exact secret JSON stays owner-only until async work completes, then directory is removed', async () => {
  let path
  const result = await withSecretJsonFile(values, async (file) => {
    path = file
    assert.equal((await stat(dirname(file))).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), values)
    await Promise.resolve()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), values)
    return 'operation completed'
  })
  assert.equal(result, 'operation completed')
  await assert.rejects(stat(path), { code: 'ENOENT' })
  await assert.rejects(stat(dirname(path)), { code: 'ENOENT' })
})

test('callback failure propagates unchanged after removing the secret directory', async () => {
  let path
  const failure = new Error('intentional deployment failure')
  await assert.rejects(withSecretJsonFile(values, async (file) => {
    path = file
    await readFile(file)
    throw failure
  }), (error) => error === failure)
  await assert.rejects(stat(dirname(path)), { code: 'ENOENT' })
})

test('failure before writing invokes no operation and leaves no temporary directory', async () => {
  const prefix = `rer-secret-test-${crypto.randomUUID()}-`
  let called = false
  await assert.rejects(withSecretJsonFile({ invalid: 1n }, () => { called = true }, { prefix }), TypeError)
  assert.equal(called, false)
  assert.deepEqual((await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)), [])
})

test('parallel operations use different private files and clean up independently', async () => {
  const paths = new Set()
  await Promise.all(['first', 'second'].map((value) => withSecretJsonFile({ KEY: value }, async (file) => {
    paths.add(file)
    await Promise.resolve()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { KEY: value })
  })))
  assert.equal(paths.size, 2)
  for (const path of paths) await assert.rejects(stat(dirname(path)), { code: 'ENOENT' })
})


test('exclusive creation rejects an existing path and cleans up after a write failure', async () => {
  const prefix = `rer-secret-exclusive-${crypto.randomUUID()}-`
  let called = false
  const values = { toJSON() {
    const directory = readdirSync(tmpdir()).find((entry) => entry.startsWith(prefix))
    assert.ok(directory)
    writeFileSync(join(tmpdir(), directory, 'secrets.json'), 'test-only existing file', { mode: 0o600 })
    return { KEY: 'test-only new value' }
  } }
  await assert.rejects(withSecretJsonFile(values, () => { called = true }, { prefix }), { code: 'EEXIST' })
  assert.equal(called, false)
  assert.deepEqual((await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)), [])
})
