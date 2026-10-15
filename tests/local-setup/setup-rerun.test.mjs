import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { scriptFixture } from './script-fixture.mjs'

const kept = /Kept the existing \.dev\.vars settings/

test('a rerun without --force says when --port or --owner-email differ from the kept settings', async (t) => {
  const { dir, run } = await scriptFixture(t)
  const path = join(dir, '.dev.vars')
  const first = await run('local-setup', ['--owner-email', 'first@example.test', '--port', '8890'])
  assert.equal(first.code, 0, first.stderr)
  assert.doesNotMatch(first.stderr, kept)
  const original = await readFile(path)
  for (const [args, message] of [
    [['--port', '8891'], 'Kept the existing .dev.vars settings; --port applies only with --force.\n'],
    [['--owner-email', 'second@example.test'], 'Kept the existing .dev.vars settings; --owner-email applies only with --force.\n'],
    [['--owner-email', 'second@example.test', '--port', '8891'], 'Kept the existing .dev.vars settings; --owner-email and --port apply only with --force.\n'],
  ]) {
    const result = await run('local-setup', args)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, message, args.join(' '))
    assert.match(result.stdout, /Open: http:\/\/127\.0\.0\.1:8890\/signin\n$/)
    assert.ok((await readFile(path)).equals(original), 'existing settings kept')
  }
  for (const args of [[], ['--owner-email', 'First@Example.test', '--port', '08890'], ['--port', '8890']]) {
    const result = await run('local-setup', args)
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stderr, kept, `unchanged values do not warn: ${args.join(' ')}`)
  }
  const forced = await run('local-setup', ['--force', '--owner-email', 'second@example.test', '--port', '8891'])
  assert.equal(forced.code, 0, forced.stderr)
  assert.doesNotMatch(forced.stderr, kept)
  assert.match(forced.stdout, /Open: http:\/\/127\.0\.0\.1:8891\/signin\n$/)
  const vars = await readFile(path, 'utf8')
  assert.match(vars, /^OWNER_EMAIL=second@example\.test$/m)
  assert.match(vars, /^AUTH_ORIGIN=http:\/\/127\.0\.0\.1:8891$/m)
})
