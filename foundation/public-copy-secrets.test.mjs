import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { testSource } from '../composition/git-source.mjs'

// Seeds copy runtime and documentation byte for byte, leaving Base tests and
// fixtures upstream through the native selector. Their public exports run Base
// publish-check over the copies. The copies alone must pass it in complete
// history and environment mode with no findings and no reviewed exceptions.
const root = resolve(import.meta.dirname, '..')
const copied = ['modules/operator-auth', 'modules/mail', 'modules/deploy-kit', 'onboarding']
// publish-check asks GitHub (through gh) whether each referenced repository is
// public. A test-only gh answers from this reviewed list of public repositories
// cited by the copied folders, without network access; any other reference
// stays unresolved and keeps the report from passing until it is reviewed.
const publicRepositories = ['cloudflare/cloudflare-typescript', 'dequelabs/axe-core', 'just-every/happytohelp', 'just-every/run-spool', 'octocat/hello-world', 'octocat/spoon-knife', 'publisher/app', 'resend/resend-openapi', 'rust-lang/crates.io-index', 'simple-icons/simple-icons', 'sqlite/sqlite', 'zloirock/core-js']

// Fictional examples only: exact normalized identities, never an owner namespace.
// These are not public dependencies or exceptions in the production publisher.
// Recheck every entry before landing/public-copy work and before adding/changing
// entries (using gh's existing credentials):
// RER_CHECK_FICTIONAL_REPOSITORIES=1 node --test --test-name-pattern='fictional identities return' foundation/public-copy-secrets.test.mjs
// Only a complete HTTP 404 Not Found response qualifies; HTTP 200 (private OR
// public), authentication/rate-limit failures and inconclusive responses fail.
// If an identity later exists or a query is inconclusive, remove/replace that
// fictional example and its entry; never treat a failed check as approval.
const fictionalRepositories = {
  'example-owner/example-repo': 'Ordinary fictional repository, including case and terminal .git URL variants.',
  'example-owner/example-repo.git': 'Literal .git repository identity from the double-suffix rejection example.',
  'example-owner./example-repo': 'Malformed owner punctuation rejection example.',
  'example-owner/example-repo.': 'Malformed double-dot .git suffix rejection example after scanner normalization.',
  'example-owner/example-r': 'Literal prefix extracted before %65 in the percent-encoding rejection example.',
  'forge/journal': 'Retained fictional identity in Unicode scheme/host rejection vectors.',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': 'Retained exact 100-character owner/repository boundary identity; 101-character rejection inputs are not allowlisted.',
}

test('fictional identities return complete GitHub HTTP 404 responses', {
  skip: process.env.RER_CHECK_FICTIONAL_REPOSITORIES !== '1',
}, t => {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' }
  delete env.GH_DEBUG; delete env.DEBUG
  for (const repository of Object.keys(fictionalRepositories)) {
    const result = spawnSync('gh', ['api', '--hostname', 'github.com', '--include', `repos/${repository}`], {
      encoding: 'utf8', env, timeout: 60_000, maxBuffer: 1024 * 1024,
    })
    // Do not print the API body, headers or child diagnostics: they may be private.
    const separator = result.stdout?.search(/\r?\n\r?\n/) ?? -1
    const status = result.stdout?.split(/\r?\n/, 1)[0].match(/^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) (\d{3})(?: [^\r\n]*)?$/)?.[1]
    let body
    try { body = JSON.parse(result.stdout.slice(separator).trim()) } catch {}
    const complete404 = !result.error && result.status === 1 && status === '404' && separator >= 0 &&
      body?.message === 'Not Found' && body?.status === '404' &&
      typeof body?.documentation_url === 'string' && /^https:\/\/docs\.github\.com\/rest\/[^\s]+$/.test(body.documentation_url)
    assert.ok(complete404, `${repository}: expected complete HTTP 404; received ${status ?? 'inconclusive'}`)
    t.diagnostic(`${repository}: HTTP 404`)
  }
})

function fakeGh(directory, states = {}) {
  mkdirSync(directory)
  writeFileSync(join(directory, 'gh'), `#!${process.execPath}
const repository = process.argv.at(-1).replace(/^repos\\//, '')
const known = ${JSON.stringify(publicRepositories)}.includes(repository) || Object.hasOwn(${JSON.stringify(fictionalRepositories)}, repository)
const state = ${JSON.stringify(states)}[repository] ?? (known ? 'public' : 'unknown')
const code = state === 'missing' ? 404 : state === 'unknown' ? 403 : 200
const body = code === 200 ? { private: state === 'private' } : code === 404 ? { message: 'Not Found', status: '404', documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository' } : {}
process.stdout.write('HTTP/2.0 ' + code + '\\n\\n' + JSON.stringify(body))
process.exitCode = code === 200 ? 0 : 1
`)
  chmodSync(join(directory, 'gh'), 0o755)
  return directory
}

test('publish-check passes over a repository holding only the copied folders', t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'public-copy-secrets-')))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const repo = join(work, 'repo'), commands = fakeGh(join(work, 'commands'))
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...copied]).toString().split('\0').filter(Boolean)
  assert.ok(files.length > 200, 'The copy holds the tracked files of every copied folder')
  for (const file of [...files.filter(file => !testSource(file)), 'LICENSE']) {
    const destination = file === 'LICENSE' ? file : join('src/base', file)
    mkdirSync(dirname(join(repo, destination)), { recursive: true })
    copyFileSync(join(root, file), join(repo, destination))
    chmodSync(join(repo, destination), statSync(join(root, file)).mode & 0o777)
  }
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Public copy', '-c', 'user.email=public-copy@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'Copied folders')
  const environment = join(work, 'credentials.env')
  writeFileSync(environment, `COPY_TEST_CANARY=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  const run = spawnSync(process.execPath, [join(root, 'scripts/publish-check.mjs'), '--repo', repo, '--ref', 'HEAD', '--env-file', environment], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: `${commands}${delimiter}${process.env.PATH}` },
  })
  const report = JSON.parse(run.stdout)
  const summary = findings => findings.map(f => `${f.rule} ${f.path}`)
  assert.deepEqual(summary(report.findings), [])
  assert.deepEqual(summary(report.reviewed), [])
  assert.equal(report.complete, true)
  assert.equal(report.status, 'PASS')
  assert.equal(run.status, 0)
})

// Every tracked module file, including tests and fixtures, must also pass after
// relocation to the edition-authoring layout. No finding class is filtered out.
const referenceRules = new Set(['hygiene.github-private', 'hygiene.github-missing', 'scan.github-incomplete'])

function scanModuleCopy(t, files, extra = {}, states = {}) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'public-module-copy-')))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const repo = join(work, 'repo'), commands = fakeGh(join(work, 'commands'), states)
  for (const file of [...files, 'LICENSE']) {
    const destination = file === 'LICENSE' ? file : join('src/base', file)
    mkdirSync(dirname(join(repo, destination)), { recursive: true })
    copyFileSync(join(root, file), join(repo, destination))
    chmodSync(join(repo, destination), statSync(join(root, file)).mode & 0o777)
    assert.deepEqual(readFileSync(join(repo, destination)), readFileSync(join(root, file)), `${file} copied byte for byte`)
  }
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), text)
  }
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Public copy', '-c', 'user.email=public-copy@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'Copied module')
  const environment = join(work, 'credentials.env')
  writeFileSync(environment, `COPY_TEST_CANARY=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  const run = spawnSync(process.execPath, [join(root, 'scripts/publish-check.mjs'), '--repo', repo, '--ref', 'HEAD', '--env-file', environment], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: `${commands}${delimiter}${process.env.PATH}` },
  })
  const report = JSON.parse(run.stdout)
  assert.equal(report.schema, 'rer.publish-check/v3')
  assert.deepEqual(report.reviewed, [], 'No publication waivers in module copies')
  return { run, report, references: report.findings.filter(f => referenceRules.has(f.rule)) }
}

test('every complete relocated module copy passes native publication with zero findings', async t => {
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'modules']).toString().split('\0').filter(Boolean)
  const modules = [...new Set(files.map(file => file.split('/').slice(0, 2).join('/')))].sort()
  assert.ok(files.length > 600, 'All tracked module files, not just production entry points')
  assert.ok(modules.includes('modules/import-kit'))
  for (const module of modules) await t.test(module, t => {
    const copy = files.filter(file => file.startsWith(module + '/'))
    assert.ok(copy.length, module)
    const { run, report, references } = scanModuleCopy(t, copy)
    assert.deepEqual(references.map(f => `${f.rule} ${f.path}`), [])
    assert.equal(report.complete, true)
    assert.equal(report.guarantees.historyScanned, true)
    assert.equal(report.guarantees.environmentChecked, true)
    assert.deepEqual(report.findings, [])
    assert.equal(report.status, 'PASS')
    assert.equal(run.status, 0)
  })
})

test('module reference check rejects private, missing and unreviewed repositories', async t => {
  const file = 'src/base/modules/import-kit/future/source.json'
  for (const [state, rule, status, exit] of [
    ['private', 'hygiene.github-private', 'FAIL', 1],
    ['missing', 'hygiene.github-missing', 'FAIL', 1],
    ['unknown', 'scan.github-incomplete', 'INCOMPLETE', 2],
  ]) await t.test(state, t => {
    const repository = `fixture-${randomBytes(8).toString('hex')}/source`
    const { run, report, references } = scanModuleCopy(t, ['modules/import-kit/schema/importers.schema.json'],
      { [file]: JSON.stringify({ sourceRepository: repository }) }, { [repository]: state })
    assert.deepEqual(references.map(f => `${f.rule} ${f.path}`), [`${rule} ${file}`])
    assert.equal(report.status, status)
    assert.equal(report.complete, state !== 'unknown')
    assert.equal(run.status, exit)
  })
})


test('relocated copy regressions reject source declarations and stated README repositories', async t => {
  for (const extension of ['js', 'ts']) await t.test(extension, t => {
    const file = `src/base/modules/import-kit/tests/mutation.${extension}`
    const repository = `fixture-${randomBytes(8).toString('hex')}/source`
    const { run, report, references } = scanModuleCopy(t, ['modules/import-kit/schema/importers.schema.json'],
      { [file]: `export const source = ${JSON.stringify({sourceRepository: repository})}` },
      { [repository]: 'private' })
    assert.equal(run.status, 1)
    assert.equal(report.status, 'FAIL')
    assert.deepEqual(references.map(f => `${f.rule} ${f.path}`), [`hygiene.github-private ${file}`])
  })
  await t.test('README relocation: a root path names a repository only with GitHub context', t => {
    const file = 'src/base/modules/sendgrid-email/README.md'
    const original = readFileSync(join(root, 'modules/sendgrid-email/README.md'), 'utf8')
    const states = { 'modules/sendgrid-email': 'missing' }
    const bare = scanModuleCopy(t, ['modules/sendgrid-email/README.md'],
      { [file]: original.replace('the `sendgrid-email` module', '`modules/sendgrid-email`') }, states)
    assert.deepEqual(bare.references, [], 'a bare word/word path is not a repository')
    const stated = scanModuleCopy(t, ['modules/sendgrid-email/README.md'],
      { [file]: original.replace('the `sendgrid-email` module', 'the `modules/sendgrid-email` repository') }, states)
    assert.equal(stated.run.status, 1)
    assert.equal(stated.report.status, 'FAIL')
    assert.deepEqual(stated.references.map(f => `${f.rule} ${f.path}`), [`hygiene.github-missing ${file}`])
  })
})

test('module reference check accepts only the exact reviewed fictional identities', t => {
  const file = 'src/base/modules/import-kit/future/source.json'
  const { run, report, references } = scanModuleCopy(t, ['modules/import-kit/schema/importers.schema.json'], {
    [file]: JSON.stringify(Object.keys(fictionalRepositories).map(repository => ({
      sourceRepository: `https://github.com/${repository}.git`,
    }))),
  })
  assert.deepEqual(references, [])
  assert.equal(report.complete, true)
  assert.equal(report.status, 'PASS')
  assert.equal(run.status, 0)
})

test('fictional examples never exempt nearby names, real private repositories or explicit states', async t => {
  const file = 'src/base/modules/import-kit/future/source.json'
  for (const [name, repository, state, rule, status, exit] of [
    ['nearby name', 'example-owner/example-repo-nearby', undefined, 'scan.github-incomplete', 'INCOMPLETE', 2],
    ['real private repository', 'runeditrun/base', 'private', 'hygiene.github-private', 'FAIL', 1],
    ['fictional private override', 'example-owner/example-repo', 'private', 'hygiene.github-private', 'FAIL', 1],
    ['fictional missing override', 'example-owner/example-repo', 'missing', 'hygiene.github-missing', 'FAIL', 1],
    ['fictional unknown override', 'example-owner/example-repo', 'unknown', 'scan.github-incomplete', 'INCOMPLETE', 2],
  ]) await t.test(name, t => {
    const { run, report, references } = scanModuleCopy(t, ['modules/import-kit/schema/importers.schema.json'],
      { [file]: JSON.stringify({ sourceRepository: repository }) }, state ? { [repository]: state } : {})
    assert.deepEqual(references.map(f => `${f.rule} ${f.path}`), [`${rule} ${file}`])
    assert.equal(report.status, status)
    assert.equal(report.complete, status !== 'INCOMPLETE')
    assert.equal(run.status, exit)
  })
})
