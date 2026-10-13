import { symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBoundaries } from '../index.mjs'
import { project, put, findings } from './helpers.mjs'

const config = { version: 1 }
const cases = [
  ['R1', 'r1', {}, [
    ['R1', 'src/ext/use.mjs', 1], ...[1, 2, 3, 4].map(line => ['R1', 'src/ext/use.ts', line]),
  ]],
  ['R2', 'r2', { R2: { mounts: { 'src/core/app/mount.server.ts': ['src/ext/index.server.ts'] } } }, [
    ['R2', 'src/core/app/mount.server.ts', 2], ['R2', 'src/core/shared/use.ts', 1],
  ]],
  ['R3', 'r3', { R3: { exceptions: ['src/core/features/delivery/mail/index.ts'] } }, [
    ['R3', 'src/core/features/a/use.ts', 1],
  ]],
  ['R4', 'r4', { R4: { specifiers: ['drizzle-orm/d1', 'custom-db'], specifierPrefixes: ['drizzle-orm/'],
    clientModules: ['src/core/platform/db/client'], allowedDirectories: ['src/core/platform/db'] } }, [
    ...[1, 2, 3, 4].map(line => ['R4', 'src/core/features/a/use.ts', line]),
  ]],
  ['R5', 'r5', {}, [
    ...[1, 2, 3, 4].map(line => ['R5', 'src/core/features/a/use.ts', line]), ['R5', 'src/ext/use.mjs', 1],
  ]],
  ['R6', 'r6', {}, [...[1, 2, 3, 4, 5].map(line => ['R6', 'src/use.ts', line])]],
  ['R7', 'r7', { R7: { files: ['src/ext/index.client.*'] } }, [
    ...[1, 2, 3].map(line => ['R7', 'src/ext/index.client.tsx', line]),
  ]],
  ['R8', 'r8', { R8: { enabled: true, files: ['src/ext/config.ts', 'src/ext/local/**'] } }, [
    ['R8', 'src/ext/config.ts', 1], ['R8', 'src/ext/local/a.mjs', 1],
  ]],
]

test('clean tree covers all eight extensions, alias, indexes, re-exports, type and literal imports', async t => {
  const result = await checkBoundaries({ root: await project(t), config })
  assert.equal(result.files, 16)
  assert.deepEqual(findings(result), [])
})
for (const [rule, fixture, rules, expected] of cases) {
  test(`${rule} exact findings`, async t => {
    const root = await project(t, fixture)
    const result = await checkBoundaries({ root, config: { ...config, rules } })
    assert.deepEqual(findings(result), expected)
    for (const item of result.violations) {
      assert.ok(item.column >= 1)
      assert.deepEqual(Object.keys(item), ['rule', 'file', 'line', 'column', 'specifier', 'target', 'message'])
      assert.ok(!item.file.includes('\\'))
    }
  })
  test(`${rule} can be turned off`, async t => {
    const root = await project(t, fixture)
    for (const disabled of [false, { ...rules[rule], enabled: false }]) {
      assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { ...rules, [rule]: disabled } } })), [])
    }
  })
}

test('R1 allowed prefixes are configurable and do not admit a sibling prefix', async t => {
  const root = await project(t, 'r1')
  assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { R1: { allowedPrefixes: ['src/core/features/a'] } } } })), [])
  assert.equal((await checkBoundaries({ root, config: { ...config, rules: { R1: { allowedPrefixes: ['src/core/features/ab'] } } } })).violations.length, 5)
})
test('R2 list mounts admit any target while pinned maps admit only exact resolved targets', async t => {
  const root = await project(t, 'r2')
  for (const mounts of [['src/core/app/mount.server.ts'], { 'src/core/app/mount.server.ts': true }]) {
    assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { R2: { mounts } } } })), [['R2', 'src/core/shared/use.ts', 1]])
  }
})
test('R3 default rejects a nested index and admits same-feature imports', async t => {
  const root = await project(t, 'r3')
  await put(root, 'src/core/features/b/local.ts', "import './private'\n")
  assert.deepEqual(findings(await checkBoundaries({ root, config })), [['R3', 'src/core/features/a/use.ts', 1], ['R3', 'src/core/features/a/use.ts', 3]])
})
test('R4 defaults restrict exactly d1 and repository filenames', async t => {
  const root = await project(t, 'r4')
  assert.deepEqual(findings(await checkBoundaries({ root, config })), [['R4', 'src/core/features/a/use.ts', 1]])
  await put(root, 'src/core/features/a/repository.server.ts', "import 'drizzle-orm/d1'\n")
  assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { R4: { allowedFiles: ['**/repository.server.ts'] } } } })), [
    ['R4', 'src/core/features/a/item-repository.ts', 1], ['R4', 'src/core/features/a/use.ts', 1],
  ])
})
test('R5 scopes, allowance and import patterns are configurable', async t => {
  const root = await project(t, 'r5')
  await put(root, 'src/ext/other.ts', "import 'custom:binding'\n")
  assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { R5: {
    importScopes: ['src/ext/**'], environmentScopes: ['src/core/app/**'], allowedDirectories: ['src/core/platform'], specifierPatterns: ['cloudflare:*'],
  } } } })), [['R5', 'src/core/app/ok.ts', 1], ['R5', 'src/ext/use.mjs', 1]])
  assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { R5: { environmentScopes: [], specifierPatterns: ['custom:*'] } } } })), [['R5', 'src/ext/other.ts', 1]])
})
test('R7 custom target pattern and R8 custom prefix', async t => {
  const clientRoot = await project(t, 'r7')
  assert.deepEqual(findings(await checkBoundaries({ root: clientRoot, config: { ...config, rules: { R7: { files: ['src/ext/index.client.*'], pattern: 'normal\\.ts$' } } } })), [['R7', 'src/ext/index.client.tsx', 4]])
  const headerRoot = await project(t, 'r8')
  assert.deepEqual(findings(await checkBoundaries({ root: headerRoot, config: { ...config, rules: { R8: { enabled: true, files: ['src/ext/local/a.mjs'], prefix: '// wrong' } } } })), [])
})
test('type-only opt-out covers declarations and named type-only specifiers', async t => {
  const root = await project(t, 'r1')
  await put(root, 'src/ext/type.ts', "import { type Private } from '../core/features/a/private'\nexport type { Private } from '../core/features/a/private'\nexport { type Private } from '../core/features/a/private'\n")
  const result = await checkBoundaries({ root, config: { ...config, includeTypeOnly: false } })
  assert.deepEqual(findings(result), [['R1', 'src/ext/use.mjs', 1], ...[2, 3, 4].map(line => ['R1', 'src/ext/use.ts', line])])
})
test('path rules ignore node_modules and targets outside the project, but specifier rules still run', async t => {
  const root = await project(t)
  await put(root, 'node_modules/external/package.json', '{"types":"index.d.ts"}')
  await put(root, 'node_modules/external/index.d.ts', 'export const value: string\n')
  await put(root, '../outside.ts', 'export const outside = 1\n')
  await put(root, 'src/ext/package.ts', "import 'external'\nimport 'drizzle-orm/d1'\nimport '../../../outside'\n")
  const result = await checkBoundaries({ root, config: { ...config, rules: { R7: { files: ['src/ext/package.ts'], pattern: '.*' } } } })
  assert.deepEqual(findings(result), [['R4', 'src/ext/package.ts', 2]])
  assert.equal(result.violations[0].target, null)
})
test('sourceRoot, nested tsconfig and deterministic file/line/rule sorting', async t => {
  const root = await project(t, 'r1')
  await put(root, 'configs/tsconfig.json', '{"extends":"../tsconfig.json"}')
  const result = await checkBoundaries({ root, config: { ...config, sourceRoot: 'src/ext', tsconfig: 'configs/tsconfig.json', rules: { R7: { files: ['src/ext/**'], pattern: 'private' } } } })
  assert.equal(result.files, 2)
  assert.deepEqual(findings(result).slice(0, 4), [['R1', 'src/ext/use.mjs', 1], ['R7', 'src/ext/use.mjs', 1], ['R1', 'src/ext/use.ts', 1], ['R7', 'src/ext/use.ts', 1]])
  assert.equal(result.violations[2].specifier, '@/core/features/a/private')
  assert.equal(result.violations[2].target, 'src/core/features/a/private.ts')
  assert.equal(result.violations[2].column, 30)
})

test('R5 specifier wildcards cover scheme subpaths without broadening source globs', async t => {
  const root = await project(t, 'r5')
  await put(root, 'src/ext/deep/use.ts', "import 'cloudflare:workers/internal'\n")
  const result = await checkBoundaries({ root, config })
  assert.ok(findings(result).some(([rule, file]) => rule === 'R5' && file === 'src/ext/deep/use.ts'))
  assert.deepEqual(findings(await checkBoundaries({ root, config: { ...config, rules: { R5: { environmentScopes: [], importScopes: ['src/ext/*.ts'] } } } })), [])
})

test('all source files include nested dependency folders and symbolic files', async t => {
  const root = await project(t, 'r6')
  await put(root, 'src/vendor/node_modules/library/use.mjs', "eval('fixture')\n")
  await put(root, '../linked.ts', "eval('fixture')\n")
  await symlink(resolve(root, '../linked.ts'), resolve(root, 'src/linked.ts'), 'file')
  await symlink(resolve(root, 'src'), resolve(root, 'src/loop'), 'dir')
  const result = await checkBoundaries({ root, config })
  assert.equal(result.files, 4)
  assert.deepEqual(findings(result), [['R6', 'src/linked.ts', 1], ...[1, 2, 3, 4, 5].map(line => ['R6', 'src/use.ts', line]), ['R6', 'src/vendor/node_modules/library/use.mjs', 1]])
})
