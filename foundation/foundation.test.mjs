import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { initialize } from './initialize.mjs'
import { assemble } from '../composition/assemble.mjs'
import { validate } from '../schema/json-schema.mjs'
import { createHash } from 'node:crypto'
import {sourceRoots} from '../cli/export.mjs'

const root = resolve(import.meta.dirname, '..')
test('committed starter exports a deterministic editable foundation without reference fixtures', async () => {
  const tmp = await mkdtemp(resolve(tmpdir(), 'rer-foundation-test-'))
  const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  try {
    const base = resolve(tmp, 'base')
    await cp(resolve(root, 'foundation'), resolve(base, 'foundation'), { recursive: true, filter: p => !p.includes('node_modules') })
    for (const name of new Set([...sourceRoots,'composition', 'edition-authoring', 'schema', 'onboarding', 'modules/operator-auth', 'export'])) await cp(resolve(root, name), resolve(base, name), { recursive: true })
    git(base, 'init'); git(base, 'add', '.'); git(base, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
    await cp(resolve(root, 'LICENSE'), resolve(base, 'LICENSE'))
    git(base, 'add', 'LICENSE'); git(base, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'license')
    const ref = git(base, 'rev-parse', 'HEAD')
    const options = { baseRepo: base, ref, family: 'future', edition: 'first', repository: 'just-every/run-orbit' }
    await writeFile(resolve(base, 'foundation/template/src/identity.ts'), 'DIRTY')
    const family = resolve(tmp, 'family')
    await initialize({ ...options, output: family })
    await initialize({ ...options, output: resolve(tmp, 'second') })
    assert.equal(await readFile(resolve(family, 'foundation.lock.json'), 'utf8'), await readFile(resolve(tmp, 'second/foundation.lock.json'), 'utf8'))
    await assert.rejects(initialize({ ...options, output: family }), /EEXIST/)
    git(family, 'init'); git(family, 'add', '.'); git(family, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'starter')
    const output = resolve(tmp, 'edition')
    await assemble({ familyRepo: family, baseRepo: base, edition: 'first', output, toolCommit: ref })
    const seed = JSON.parse(await readFile(resolve(output, 'seed.json')))
    assert.deepEqual(validate(JSON.parse(await readFile(resolve(root, 'schema/SEED.schema.json'))), seed), [])
    assert.match(await readFile(resolve(output, 'src/identity.ts'), 'utf8'), /branding.name/)
    const lock = JSON.parse(await readFile(resolve(output, 'composition.lock.json')))
    assert.equal(lock.files['src/base/dispatch.ts'].repository, 'base')
    assert.equal(lock.files['scripts/base-onboarding/server.mjs'].repository, 'base')
    assert.equal(JSON.parse(await readFile(resolve(output, 'src/branding.json'))).name, 'first')
    const origin = JSON.parse(await readFile(resolve(family, 'foundation.lock.json')))
    assert.ok(origin.runtime['onboarding/server.mjs'])
    assert.ok(!Object.keys(lock.files).some(p => p.startsWith('src/core/features/reference/')))
    assert.equal(lock.files['migrations/core/0001_owner.sql'].repository, 'base')
    assert.equal(lock.files['scripts/base-cli/cli/main.mjs'].repository, 'base')
    assert.equal(JSON.parse(await readFile(resolve(output,'OPERATIONS.json'))).seedContract.profile, 'first-party')
    for (const path of ['RUN-LOCALLY.md','SEED-COMMAND-CONTRACT.md','scripts/installer/local.mjs','scripts/installer/seed.mjs','.node-version','package.json']) {
      assert.ok(lock.files[path], `export provenance includes ${path}`)
      assert.equal(createHash('sha256').update(await readFile(resolve(output,path))).digest('hex'),lock.files[path].sha256,`export bytes match provenance for ${path}`)
    }
    assert.ok(!Object.keys(origin.runtime).some(p => /\.test\.|\/fixtures\/|browser-(check|output)\.mjs$/.test(p)))
    assert.ok(!Object.keys(lock.files).some(p => p.startsWith('scripts/base-onboarding/') && /\.test\.|\/fixtures\/|browser-(check|output)\.mjs$/.test(p)))
  } finally { await rm(tmp, { recursive: true, force: true }) }
})
