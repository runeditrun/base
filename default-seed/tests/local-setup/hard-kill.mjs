import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localOperation } from '../../scripts/base-onboarding/local/operation.mjs'
import { scriptFixture } from './script-fixture.mjs'

export const recoveryRows = []

const credentials = () => Buffer.from(`# private comment\nOWNER_EMAIL=owner@example.test\nAUTH_LOCAL=true\nAUTH_ORIGIN=http://127.0.0.1:8899\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nSETUP_TOKEN=${randomBytes(32).toString('hex')}\nMAIL_PROVIDER=development\n`)

async function stranded(dir) {
  const found = []
  for (const folder of ['local-build', 'local-setup']) {
    const parent = join(dir, '.wrangler', folder)
    for (const run of await readdir(parent).catch(() => [])) {
      for (const name of await readdir(join(parent, run))) {
        if (!name.startsWith('original.') && name !== 'previous.dev.vars') continue
        const path = join(parent, run, name)
        if (await stat(path).catch(() => undefined)) found.push(path)
      }
    }
  }
  return found
}

async function assertLockFree(dir) {
  const operation = await localOperation(dir)
  await operation.release()
}

for (const killed of ['local-build', 'local-setup']) {
  for (const next of ['local-build', 'local-setup', 'local-dev']) {
    recoveryRows.push([`after a SIGKILLed ${killed}, ${next} restores the exact original .dev.vars`, { timeout: 30000 }, async (t) => {
      const { dir, run, hardKill, calls } = await scriptFixture(t)
      const path = join(dir, '.dev.vars')
      const original = credentials()
      await writeFile(path, original, { mode: 0o640 })
      const before = await stat(path)
      await hardKill(killed)
      await assert.rejects(stat(path), { code: 'ENOENT' }, 'the hard kill stranded .dev.vars')
      const [hidden, ...others] = await stranded(dir)
      assert.ok(hidden && others.length === 0, 'one stranded original')
      const result = await run(next)
      assert.equal(result.code, 0, result.stderr)
      assert.ok(result.stderr.includes(`Restored .dev.vars from an interrupted build or setup (${hidden}).`), result.stderr)
      assert.ok((await readFile(path)).equals(original), 'exact bytes restored')
      const after = await stat(path)
      assert.equal(after.ino, before.ino)
      assert.equal(after.mode & 0o777, 0o640)
      assert.equal(after.nlink, 1)
      assert.deepEqual(await stranded(dir), [])
      await assert.rejects(stat(join(dir, '.dev.vars.previous')), { code: 'ENOENT' }, 'no credentials were rotated')
      const last = (await calls()).at(-1)
      if (next === 'local-dev') assert.deepEqual(last.args.slice(0, 3), ['exec', 'wrangler', 'dev'])
      else assert.equal(last.varsPresent, false, 'the following build still ran without .dev.vars')
      if (next === 'local-setup') assert.match(result.stdout, /Local setup ready/)
      await assertLockFree(dir)
    }])
  }
}

recoveryRows.push(['several stranded originals stop build, setup and dev fixtures with their paths', { timeout: 30000 }, async (t) => {
  const { dir, run, hardKill, calls } = await scriptFixture(t)
  await writeFile(join(dir, '.dev.vars'), credentials(), { mode: 0o600 })
  await hardKill('local-build')
  const second = join(dir, '.wrangler/local-setup/run-other')
  await mkdir(second, { recursive: true, mode: 0o700 })
  await writeFile(join(second, 'previous.dev.vars'), credentials(), { mode: 0o600 })
  const paths = await stranded(dir)
  assert.equal(paths.length, 2)
  const count = (await calls()).length
  for (const script of ['local-build', 'local-setup', 'local-dev']) {
    const result = await run(script)
    assert.equal(result.code, 1, script)
    assert.match(result.stderr, /\.dev\.vars is missing and interrupted runs left several private originals/)
    for (const path of paths) assert.ok(result.stderr.includes(path), `${script} names ${path}`)
    await assert.rejects(stat(join(dir, '.dev.vars')), { code: 'ENOENT' }, `${script} created no new credentials`)
    assert.deepEqual(await stranded(dir), paths)
    assert.equal((await calls()).length, count, `${script} ran no command`)
    await assertLockFree(dir)
  }
}])

recoveryRows.push(['the dev fixture waits for a running build instead of taking its hidden credentials', { timeout: 30000 }, async (t) => {
  const { dir, run, hang, calls } = await scriptFixture(t)
  const path = join(dir, '.dev.vars')
  const original = credentials()
  await writeFile(path, original, { mode: 0o600 })
  const build = await hang('local-build')
  const [hidden] = await stranded(dir)
  const lock = join(dir, '.wrangler/local-operation/active.json')
  const owner = await readFile(lock)
  const count = (await calls()).length
  for (const script of ['local-dev', 'local-setup', 'local-build']) {
    const result = await run(script)
    assert.equal(result.code, 1, script)
    assert.match(result.stderr, new RegExp(`\\bPID ${build.child.pid} \\([a-zA-Z0-9._-]+\\)`))
    assert.ok(owner.equals(await readFile(lock)), `${script} preserves the running build's lock`)
    await assert.rejects(stat(path), { code: 'ENOENT' }, `${script} left the running build's file hidden`)
    assert.deepEqual(await stranded(dir), [hidden])
    assert.ok((await readFile(hidden)).equals(original), `${script} preserves the exact hidden credentials`)
    assert.equal((await calls()).length, count, `${script} ran no command`)
  }
  build.child.kill('SIGTERM')
  assert.equal((await build.exited).code, 1)
  assert.ok((await readFile(path)).equals(original), 'the running build restored its own file')
}])

recoveryRows.push(['a restore interrupted before its private link was removed is completed', {}, async (t) => {
  const { dir, run } = await scriptFixture(t)
  const path = join(dir, '.dev.vars')
  const original = credentials()
  await writeFile(path, original, { mode: 0o600 })
  const leftover = join(dir, '.wrangler/local-build/run-interrupted')
  await mkdir(leftover, { recursive: true, mode: 0o700 })
  await link(path, join(leftover, 'original.dev.vars'))
  const result = await run('local-build')
  assert.equal(result.code, 0, result.stderr)
  assert.ok((await readFile(path)).equals(original))
  assert.equal((await stat(path)).nlink, 1)
  assert.deepEqual(await stranded(dir), [])
}])

recoveryRows.push(['an earlier stranded copy beside a current .dev.vars is named, not used', {}, async (t) => {
  const { dir, run } = await scriptFixture(t)
  const path = join(dir, '.dev.vars')
  const current = credentials()
  await writeFile(path, current, { mode: 0o600 })
  const leftover = join(dir, '.wrangler/local-setup/run-interrupted')
  await mkdir(leftover, { recursive: true, mode: 0o700 })
  const copy = join(leftover, 'previous.dev.vars')
  await writeFile(copy, credentials(), { mode: 0o600 })
  for (const script of ['local-build', 'local-dev']) {
    const result = await run(script)
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.stderr.includes(`An interrupted build or setup left an earlier private copy of .dev.vars at ${copy}.`), result.stderr)
    assert.ok((await readFile(path)).equals(current))
    assert.deepEqual(await stranded(dir), [copy])
  }
}])
