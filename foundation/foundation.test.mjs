import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { initialize } from './initialize.mjs'
import { assemble } from '../composition/assemble.mjs'
import { validate } from '../schema/json-schema.mjs'
import { createHash } from 'node:crypto'
import {sourceRoots} from '../cli/export.mjs'

const root = resolve(import.meta.dirname, '..')
test('public foundation CLI keeps author identity private from Run data and composes clean migrations', async () => {
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
    const authorRepository = `author-${process.pid}/family-${Date.now()}`
    const editionName = 'first'
    const options = { baseRepo: base, ref, family: 'future', edition: editionName, repository: authorRepository }
    const initializeFromCLI = supplied => execFileSync(process.execPath, [
      resolve(base, 'foundation/cli.mjs'),
      '--base-repo', supplied.baseRepo,
      '--ref', supplied.ref,
      '--output', supplied.output,
      '--family', supplied.family,
      '--edition', supplied.edition,
      '--repository', supplied.repository,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    const publicRepository = edition => new URL(['just-every', `run-${edition}`].join('/'), 'https://github.com/').href
    await writeFile(resolve(base, 'foundation/template/src/identity.ts'), 'DIRTY')
    const family = resolve(tmp, 'family')
    assert.equal(JSON.parse(initializeFromCLI({ ...options, output: family })).baseCommit, ref)
    const repeated = resolve(tmp, 'repeated')
    initializeFromCLI({ ...options, output: repeated })
    assert.equal(await readFile(resolve(family, 'foundation.lock.json'), 'utf8'), await readFile(resolve(repeated, 'foundation.lock.json'), 'utf8'))
    await assert.rejects(initialize({ ...options, output: family }), /EEXIST/)
    const secondEditionName = 'second'
    const secondEdition = resolve(tmp, 'second-edition')
    initializeFromCLI({ ...options, edition: secondEditionName, output: secondEdition, repository: `author-${process.pid}/other-${Date.now()}` })
    const secondRun = JSON.parse(await readFile(resolve(secondEdition, `editions/${secondEditionName}/src/site/run.json`)))
    const secondRepository = publicRepository(secondEditionName)
    assert.equal(secondRun.repository, secondRepository)
    assert.equal(secondRun.clone, `npx -y @runeditrun/rer dev just-every/run-${secondEditionName}`)
    assert.equal(secondRun.folder, `run-${secondEditionName}`)
    const secondSetup = JSON.parse(await readFile(resolve(secondEdition, `editions/${secondEditionName}/rer-setup.json`)))
    assert.equal(secondSetup.title, secondEditionName)
    assert.equal(secondSetup.fields.find(field => field.name === 'APP_NAME').default, secondEditionName)
    git(family, 'init'); git(family, 'add', '.'); git(family, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'starter')
    const output = resolve(tmp, 'edition')
    await assemble({ familyRepo: family, baseRepo: base, edition: 'first', output, toolCommit: ref })
    // Exercise the composed mail facade with the real selected mail module.
    // Network is the only fake: local/demo must never reach a provider, even
    // when the installation already has hosted mail credentials configured.
    const { operatorMail } = await import(pathToFileURL(resolve(output, 'src/mail.server.mjs')))
    const message = { deliveryId: 'foundation-sign-in', from: 'auth@example.test', to: ['owner@example.test'], subject: 'Sign in', text: 'Your sign-in link' }
    const liveFetch = globalThis.fetch
    let providerCalls = 0
    globalThis.fetch = async () => { providerCalls++; return Response.json({ id: 'test-delivery' }) }
    try {
      for (const mode of [{ AUTH_LOCAL: 'true' }, { RER_DEMO: '1' }]) {
        const env = { ...mode, MAIL_PROVIDER: 'resend', get MAIL_API_KEY() { throw Error('suppressed mail read provider credentials') }, get DB() { throw Error('suppressed mail used the database') } }
        assert.equal((await operatorMail(env).send(message)).status, 'development')
      }
      assert.equal(providerCalls, 0)
      assert.equal(operatorMail({ MAIL_PROVIDER: 'development' }), undefined)
      assert.equal((await operatorMail({ MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-only-provider-key' }).send(message)).status, 'accepted')
      assert.equal(providerCalls, 1)
    } finally { globalThis.fetch = liveFetch }
    const seed = JSON.parse(await readFile(resolve(output, 'seed.json')))
    assert.deepEqual(validate(JSON.parse(await readFile(resolve(root, 'schema/SEED.schema.json'))), seed), [])
    assert.match(await readFile(resolve(output, 'src/identity.ts'), 'utf8'), /branding.name/)
    const lock = JSON.parse(await readFile(resolve(output, 'composition.lock.json')))
    assert.equal(lock.files['src/base/dispatch.ts'].repository, 'base')
    assert.equal(lock.files['scripts/base-onboarding/server.mjs'].repository, 'base')
    assert.equal(JSON.parse(await readFile(resolve(output, 'src/branding.json'))).name, 'first')
    const authorManifest = JSON.parse(await readFile(resolve(family, 'family.json')))
    assert.equal(authorManifest.repository, authorRepository)
    const run = JSON.parse(await readFile(resolve(family, `editions/${editionName}/src/site/run.json`)))
    const firstRepository = publicRepository(editionName)
    assert.equal(run.repository, firstRepository)
    assert.equal(run.clone, `npx -y @runeditrun/rer dev just-every/run-${editionName}`)
    assert.equal(run.folder, `run-${editionName}`)
    assert.doesNotMatch(JSON.stringify(run), new RegExp(authorRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const setup = JSON.parse(await readFile(resolve(family, `editions/${editionName}/rer-setup.json`)))
    assert.equal(setup.title, editionName)
    assert.equal(setup.fields.find(field => field.name === 'APP_NAME').default, editionName)
    const migrations = await Promise.all((await readdir(resolve(output, 'migrations/core')))
      .filter(name => name.endsWith('.sql'))
      .map(async name => ({ name, sql: await readFile(resolve(output, 'migrations/core', name), 'utf8') })))
    const ordinals = migrations.map(({ name }) => /^(\d+)_/.exec(name)?.[1]).filter(Boolean)
    assert.equal(new Set(ordinals).size, ordinals.length)
    const dependencySetup = migrations.find(({ sql }) => /CREATE TABLE(?: IF NOT EXISTS)?\s+oa_setup_links\b/.test(sql))
    const erasure = migrations.find(({ sql }) => /CREATE TABLE(?: IF NOT EXISTS)?\s+rer_erasure_operations\b/.test(sql))
    assert.ok(dependencySetup, 'generated SQL retains the provider dependency setup table')
    assert.ok(erasure, 'generated SQL retains the erasure operations table')
    assert.notEqual(/^(\d+)_/.exec(dependencySetup.name)?.[1], /^(\d+)_/.exec(erasure.name)?.[1])
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
