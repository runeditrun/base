import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createResolver } from '../resolution.mjs'
import { validateConfig } from '../config.mjs'
import { project, put, run, typescript } from './helpers.mjs'

test('a project without typescript fails exit 2 and names the package', async t => {
  const root = await project(t, 'clean', { linkTypescript: false })
  await put(root, 'boundaries.json', '{"version":1}')
  const result = run(root)
  assert.equal(result.status, 2)
  assert.equal(result.stderr, 'Boundary check configuration error: Cannot resolve the project package typescript from package.json; install typescript in the project\n')
})
test('resolution uses the project copy of typescript rather than the checker location', async t => {
  const root = await project(t)
  const resolver = createResolver(root, validateConfig({ version: 1 }))
  const ownPackage = JSON.parse(await readFile(resolve(typescript, 'package.json'), 'utf8'))
  assert.equal(resolver.ts.version, ownPackage.version)
  assert.equal(resolver.resolveSpecifier('@/core/api', resolve(root, 'src/ext/index.ts')), 'src/core/api/index.ts')
  assert.equal(resolver.resolveSpecifier('../core/api', resolve(root, 'src/ext/index.ts')), 'src/core/api/index.ts')
})
