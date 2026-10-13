import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createResolver } from '../resolution.mjs'
import { validateConfig } from '../config.mjs'
import { project } from './helpers.mjs'

test('fixture roots and consumer resolution work through a symlinked temporary directory', async t => {
  const parent = await mkdtemp(resolve(tmpdir(), 'boundary-temporary-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const physical = resolve(parent, 'physical'), logical = resolve(parent, 'logical')
  await mkdir(physical)
  await symlink(physical, logical, 'dir')
  const root = await project(t, 'clean', { temporaryDirectory: logical })
  assert.equal(root, await realpath(root))
  const resolver = createResolver(root, validateConfig({ version: 1 }))
  assert.equal(resolver.resolveSpecifier('@/core/api', resolve(root, 'src/ext/index.ts')), 'src/core/api/index.ts')
  assert.equal(resolver.resolveSpecifier('../core/api', resolve(root, 'src/ext/index.ts')), 'src/core/api/index.ts')
})
