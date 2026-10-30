import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContract } from './runtime/seed-contract.mjs'

const fixtures = join(import.meta.dirname, 'fixtures/contract-docs')
const generatedFiles = ['CONTRACT.md', 'ACCEPTANCE.md', 'docs/CLAIMS.md']
const read = (root, path) => readFile(join(root, path), 'utf8')
const edit = (root, path, contents) => writeFile(join(root, path), contents)
const snapshot = root => Promise.all(generatedFiles.map(path => read(root, path)))
const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=Base test', '-c', 'user.email=base-test@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim()
const cli = (root, ...args) => {
  const result = spawnSync(process.execPath, ['src/base/contract-docs.mjs', ...args], { cwd: root, encoding: 'utf8' })
  assert.ifError(result.error)
  return { ...result, output: result.stdout + result.stderr }
}
const succeeds = (root, ...args) => {
  const result = cli(root, ...args)
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.output}`)
  return result
}
const refuses = (root, path, ...args) => {
  const result = cli(root, ...args)
  assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly passed`)
  assert.ok(result.output.includes(path), `${path} was not named:\n${result.output}`)
}

async function installation(fixture) {
  const root = await mkdtemp(join(tmpdir(), 'contract-docs-'))
  await cp(join(fixtures, fixture), root, { recursive: true })
  await mkdir(join(root, 'src/base'), { recursive: true })
  await Promise.all(['contract-docs.mjs', 'contract-anchor.mjs', 'contract-prose.mjs', 'contract-prose-patterns.mjs', 'seed-contract.mjs'].map(file =>
    cp(join(import.meta.dirname, 'runtime', file), join(root, 'src/base', file))))
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'Synthetic source')
  return root
}

test('the seed CLI refuses generated acceptance and unclassified tools, while literal prose matches only warn', async () => {
  const root = await installation('standard')
  try {
    await edit(root, 'ACCEPTANCE.md', '# Accept the catalogue\n\n#### E1 — Maintain an entry\n\n1. A saved description remains readable after reopening the entry.\n')
    git(root, 'add', '.')
    git(root, '-c', 'user.name=Synthetic author', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Handwritten acceptance')
    succeeds(root, 'coverage', 'init', '--old', 'HEAD')
    succeeds(root, 'write')
    succeeds(root, 'check-prose')
    const source = await read(root, 'CONTRACT.md')
    const coveragePath = 'docs/contract/COVERAGE.json'
    const coverage = JSON.parse(await read(root, coveragePath))
    const acceptance = coverage.fragments.find(fragment => fragment.file === 'ACCEPTANCE.md' && fragment.text.startsWith('1.'))
    assert.ok(acceptance, 'the old acceptance outcome must remain placed')
    acceptance.to = 'generated'
    acceptance.note = 'The contract generator writes this status or count.'
    delete acceptance.ids
    await edit(root, coveragePath, JSON.stringify(coverage))
    await edit(root, 'CONTRACT.md', source
      .replace('standard or access |', ' |')
      .replace('An invalid description leaves the saved description intact.', 'An invalid description leaves the saved description intact. Assignment never grants access. Run pnpm test:push.'))
    succeeds(root, 'write')
    const result = cli(root, 'check-prose')
    assert.notEqual(result.status, 0, result.output)
    for (const family of ['a', 'b', 'c', 'd']) assert.match(result.output, new RegExp(`(?:ERROR|WARN) E1 ${family} `))
    assert.match(result.output, /matched .*Assignment never grants access/)
    assert.match(result.output, /matched .*Run pnpm test:push/)
    refuses(root, 'E1', 'check')

    // Removing a whole class column is also an unclassified declaration.
    await edit(root, 'CONTRACT.md', source.replace(/ \| Risk class/g, '').replace(/ \| standard(?: or access)?/g, ''))
    refuses(root, 'tool-class', 'check-prose')
    acceptance.to = 'clause'
    acceptance.ids = ['E1']
    await edit(root, coveragePath, JSON.stringify(coverage))
    await edit(root, 'CONTRACT.md', source.replace('An invalid description leaves the saved description intact.', 'An invalid description leaves the saved description intact. Assignment never grants access.'))
    assert.match(succeeds(root, 'check-prose').output, /WARN E1 b /)
    await edit(root, 'CONTRACT.md', source)
    succeeds(root, 'write')
    assert.match(succeeds(root, 'check').output, /Contract prose: 0 errors, 0 warnings/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function generatedJourney(root) {
  succeeds(root, 'write')
  succeeds(root, 'check')
  const first = await snapshot(root)
  succeeds(root, 'write')
  assert.deepEqual(await snapshot(root), first, 'regenerating changed already generated documents')
  const acceptance = await read(root, 'ACCEPTANCE.md')
  await edit(root, 'ACCEPTANCE.md', acceptance.replace(/^1\..+$/m, '$& Hand-edited outcome.'))
  refuses(root, 'ACCEPTANCE.md', 'check')
  succeeds(root, 'write')
  succeeds(root, 'check')
  assert.equal(await read(root, 'ACCEPTANCE.md'), acceptance)
}

test('a committed anchor preserves generation without history and refuses unauthenticated source objects', async () => {
  const root = await installation('standard')
  const copies = await mkdtemp(join(tmpdir(), 'contract-anchor-'))
  try {
    const old = git(root, 'rev-parse', 'HEAD')
    succeeds(root, 'coverage', 'init', '--old', old)
    succeeds(root, 'write')
    succeeds(root, 'check')
    const expected = await snapshot(root)
    succeeds(root, 'anchor', '--old', old)
    const recordPath = 'docs/contract/ANCHOR.json', record = await read(root, recordPath)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Record portable anchor and current documents')
    const shallow = join(copies, 'shallow'), bare = join(copies, 'snapshot')
    git(root, 'clone', '-q', '--depth', '1', `file://${root}`, shallow)
    await cp(shallow, bare, { recursive: true })
    await rm(join(bare, '.git'), { recursive: true })
    assert.notEqual(spawnSync('git', ['cat-file', '-e', old], { cwd: shallow }).status, 0, 'shallow fixture must lack the original')
    for (const copy of [shallow, bare]) {
      succeeds(copy, 'check')
      succeeds(copy, 'write')
      assert.deepEqual(await snapshot(copy), expected)
      await rm(join(copy, recordPath))
      refuses(copy, 'contract_anchor_missing', 'write')
      refuses(copy, 'contract_anchor_missing', 'check')
      await edit(copy, recordPath, record)
    }
    const original = JSON.parse(record)
    const corruptions = [
      value => { value.commit = git(root, 'rev-parse', 'HEAD') },
      value => { value.objects[old].data = Buffer.from('forged commit').toString('base64') },
      value => { Object.values(value.objects).find(object => object.type === 'tree').data = Buffer.from('forged tree').toString('base64') },
      value => { Object.values(value.objects).find(object => object.type === 'blob').data = Buffer.from('forged historical answer').toString('base64') },
      value => { delete value.objects[Object.keys(value.objects).find(id => value.objects[id].type === 'blob')] },
    ]
    for (const corrupt of corruptions) {
      const value = structuredClone(original)
      corrupt(value)
      // Full history must not rescue a tampered record either.
      for (const copy of [root, shallow, bare]) {
        await edit(copy, recordPath, JSON.stringify(value))
        refuses(copy, 'contract_anchor_invalid', 'write')
        refuses(copy, 'contract_anchor_invalid', 'check')
        assert.deepEqual(await snapshot(copy), expected, 'refusal must precede generated writes')
      }
    }
    await rm(join(root, recordPath))
    succeeds(root, 'write')
    succeeds(root, 'check')
    assert.deepEqual(await snapshot(root), expected, 'full history without a record keeps identical output')
  } finally {
    await Promise.all([root, copies].map(path => rm(path, { recursive: true, force: true })))
  }
})

async function nonProductJourney() {
  const sources = [
    [
      [6, '"100% free, open source alternative to Expensify, SAP Concur and Emburse"', 'OWN', 'license/public-repository ownership'],
      [51, '"100% free and open source. MIT licensed."', 'OWN', 'license/public-repository ownership'],
    ],
    [
      [6, '"100% free, open source alternative to Stripe Billing, Chargebee and Recurly"', '—', 'license/public-repository ownership'],
      [71, 'Terminal: `npx -y @runeditrun/rer dev just-every/run-nectar` starts Nectar', '—', 'launcher identity'],
      [73, '"100% free and open source. MIT licensed."', '—', 'license/public-repository ownership'],
      [76, '"Try the demo" opens the hosted demo', '—', 'hosted-demo action'],
    ],
    [[37, 'Limits: "No desktop or screen-scraping robots"', 'none needed: a boundary, true of the code', 'boundary']],
  ]
  for (const facts of sources) {
    const root = await installation('legacy')
    try {
      await rm(join(root, 'docs/CLAIMS.md'))
      const initial = await read(root, 'CONTRACT.md')
      const table = [
        '| # | Section | Claim | Clause(s) | Status |', '| --- | --- | --- | --- | --- |',
        "| 1 | Hero | Publish the studio's entries | PUBLISH-01 | done |",
        ...facts.map(([number, claim, reference]) => `| ${number} | Closing | ${claim} | ${reference} | done |`),
      ].join('\n')
      await edit(root, 'CONTRACT.md', initial.replace(/\| # \| Claim \| Clauses \|[\s\S]*?(?=\n## Status)/, table + '\n'))
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Synthetic historical homepage source')
      const old = git(root, 'rev-parse', 'HEAD'), before = parseContract(await read(root, 'CONTRACT.md'))
      const lines = (await read(root, 'CONTRACT.md')).split('\n')
      const claims = facts.map(([, claim, , nonProduct]) => ({ file: 'CONTRACT.md', line: lines.findIndex(line => line.includes(`| ${claim} |`)) + 1, claim, nonProduct }))
      await edit(root, 'claim-map.json', JSON.stringify({ schema: 1, old, claims }))
      succeeds(root, 'convert', '--old', old, '--claim-map', 'claim-map.json')
      succeeds(root, 'check')
      succeeds(root, 'id-map', '--old', old)
      succeeds(root, 'coverage', 'check', '--old', old)
      assert.deepEqual(parseContract(await read(root, 'CONTRACT.md')).clauses.map(({ id, status }) => ({ id, status })), before.clauses.map(({ id, status }) => ({ id, status })))
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

async function prepareProseClaims(root) {
  // Prose journeys use valid links; the legacy journey below separately proves
  // that historical aliases require a reviewed, source-bound claim map.
  const claims = await read(root, 'docs/CLAIMS.md')
  await edit(root, 'docs/CLAIMS.md', claims.replace('| OWN-01 |', '| E1 |').replace('| Honest boundaries |', '| PUBLISH-01 |').replace('| — |', '| AUTH-HOST-01 |'))
  git(root, 'add', 'docs/CLAIMS.md')
  git(root, 'commit', '-qm', 'Synthetic prose journey claims')
}

async function statusLineJourney(root) {
  await prepareProseClaims(root)
  const source = await read(root, 'CONTRACT.md')
  const requirement = "Owners can change an entry's description without changing its identity."
  const acceptance = '**Acceptance:**\n1. Save the description.\n2. Keep the entry owner.'
  const formats = [state => `*Status:* ${state}.`, state => `Status: ${state}`, state => `**Status:** ${state}.`, state => `**Status: ${state}.**`]
  const save = text => {
    return edit(root, 'CONTRACT.md', text).then(() => {
      git(root, 'add', 'CONTRACT.md')
      git(root, 'commit', '-qm', 'Synthetic status source')
    })
  }
  for (const format of formats) {
    const text = source
      .replace('** Visitors can read published entries.', `** ${format('done')}\n  Visitors can read published entries.`)
      .replace(requirement, `${format('partial')}\n\n${requirement}`)
      .replace('**Acceptance evidence:** The editor saves the description and keeps the entry\'s owner.', acceptance)
      .replace('Archive collections for a long retention period.', `${format('missing')}\n\nArchive collections for a long retention period.`)
    await save(text)
    const old = parseContract(text)
    succeeds(root, 'convert', '--old', 'HEAD')
    succeeds(root, 'check')
    succeeds(root, 'coverage', 'check', '--old', 'HEAD')
    const convertedText = await read(root, 'CONTRACT.md')
    const converted = parseContract(convertedText)
    assert.deepEqual(converted.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })),
      old.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })))
    assert.equal(converted.commit, old.commit)
    assert.equal(converted.date, old.date)
    assert.ok(convertedText.includes(`**Requirement.** ${requirement}\n\n**Acceptance.**\n1. Save the description.\n2. Keep the entry owner.`))
    assert.ok(convertedText.includes('**Requirement.** Visitors can read published entries.\nDraft entries stay private.'))
    assert.ok(convertedText.includes('**Requirement.** Archive collections for a long retention period. Archived entries remain readable.'))
    assert.ok(!convertedText.includes(format('partial')), 'recorded status became requirement or acceptance text')
    assert.ok((await read(root, 'CHANGELOG.md')).includes(format('partial')), 'the original status was not retained in history')
    git(root, 'reset', '--hard', 'HEAD')
    git(root, 'clean', '-fd')
    for (const [invalid, diagnostic] of [
      [text.replace(requirement, ''), 'An old clause has no requirement prose to convert.'],
      [text.replace(format('partial'), format('done')), 'Status'],
    ]) {
      await save(invalid)
      const before = await snapshot(root)
      refuses(root, diagnostic, 'convert', '--old', 'HEAD')
      assert.deepEqual(await snapshot(root), before, 'refused conversion changed source documents')
    }
  }
}

async function blockquoteJourney(root) {
  await prepareProseClaims(root)
  const source = await read(root, 'CONTRACT.md')
  const original = '- **PUBLISH-01 — Publish the catalogue.** Visitors can read published entries.\n  Draft entries stay private.'
  const heading = '- **PUBLISH-01 — Publish the catalogue.**'
  const prose = 'Visitors can read published entries.\nDraft entries stay private.\n\n**Acceptance:**\n1. Read the catalogue.\n2. Refuse the private draft.'
  const save = async text => {
    await edit(root, 'CONTRACT.md', text)
    git(root, 'add', 'CONTRACT.md')
    git(root, 'commit', '-qm', 'Synthetic blockquote source')
  }
  let indented
  for (const prefix of ['  ', '> ', '  > ']) {
    const body = prefix.includes('>') ? `*Status:* done.\n\n${prose}` : prose
    const text = source.replace(original, `${heading}\n${body.split('\n').map(line => prefix + line).join('\n')}\n\n- An unrelated bullet stays outside this clause.`)
    await save(text)
    const old = parseContract(text)
    succeeds(root, 'convert', '--old', 'HEAD')
    succeeds(root, 'check')
    succeeds(root, 'coverage', 'check', '--old', 'HEAD')
    const convertedText = await read(root, 'CONTRACT.md')
    const converted = parseContract(convertedText)
    assert.deepEqual(converted.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })),
      old.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })))
    assert.equal(converted.commit, old.commit)
    assert.equal(converted.date, old.date)
    const clause = convertedText.split('#### PUBLISH-01')[1].split('## Target clauses')[0]
    assert.ok(clause.includes('**Requirement.** Visitors can read published entries.\nDraft entries stay private.\n\n**Acceptance.**\n1. Read the catalogue.\n2. Refuse the private draft.'))
    assert.ok(!clause.includes('unrelated bullet'))
    if (indented === undefined) indented = clause
    else assert.equal(clause, indented, 'a quoted body must convert like an indented body')
    assert.ok((await read(root, 'CHANGELOG.md')).includes(text.trim()), 'the original quote was not retained in history')
    git(root, 'reset', '--hard', 'HEAD')
    git(root, 'clean', '-fd')
  }
  // A quote marker, status or acceptance list alone is not requirement prose.
  // Neither the following clause bullet nor a heading can supply missing prose.
  for (const boundary of ['- **', '#### ']) {
    const text = source.replace(original, `${heading}\n> *Status:* done.\n>\n> **Acceptance:**\n> 1. Read the catalogue.`)
      .replace('**E1 — Maintain an entry.** ', `${boundary}E1 — Maintain an entry.${boundary === '- **' ? '**' : ''}\n\n`)
    await save(text)
    const before = await snapshot(root)
    refuses(root, 'An old clause has no requirement prose to convert.', 'convert', '--old', 'HEAD')
    assert.deepEqual(await snapshot(root), before, 'refused conversion changed source documents')
  }
}

test('contract docs convert handwritten contracts and keep generated documents and migration maps accountable', async () => {
  const roots = await Promise.all(['standard', 'legacy', 'legacy', 'legacy'].map(installation))
  try {
    const results = await Promise.allSettled([
      nonProductJourney(),
      (async () => {
        const root = roots[0]
        const original = parseContract(await read(root, 'CONTRACT.md'))
        await generatedJourney(root)
        assert.deepEqual(parseContract(await read(root, 'CONTRACT.md')), original)
        git(root, 'add', '.')
        git(root, 'commit', '-qm', 'Generated documents')
        succeeds(root, 'write')
        assert.equal(git(root, 'status', '--porcelain'), '', 'a second write leaves the committed checkout clean')
        const acceptance = await read(root, 'ACCEPTANCE.md')
        for (const clause of original.clauses) {
          assert.ok(acceptance.includes(`#### ${clause.id} — ${clause.title}`), clause.id)
          assert.ok(acceptance.includes(clause.gap || '**Gap.** None.'), clause.id)
        }
        const source = await read(root, 'CONTRACT.md')
        const requirement = '**Requirement.** A visitor reads the studio\'s published entries.'
        const revised = `${requirement} Titles remain searchable.`
        await edit(root, 'CONTRACT.md', source.replace(requirement, revised))
        refuses(root, 'ACCEPTANCE.md', 'check')
        succeeds(root, 'write')
        succeeds(root, 'check')
        assert.ok((await read(root, 'ACCEPTANCE.md')).includes(revised))
        assert.ok((await read(root, 'docs/CLAIMS.md')).includes('Section'))
      })(),
      statusLineJourney(roots[2]),
      blockquoteJourney(roots[3]),
      (async () => {
        const root = roots[1]
        const oldSource = await read(root, 'CONTRACT.md')
        const old = parseContract(oldSource)
        const oldCommit = git(root, 'rev-parse', 'HEAD')
        const claimSource = await read(root, 'docs/CLAIMS.md')
        const claimMap = { schema: 1, old: oldCommit, claims: [
          ["Keep each entry's identity", 'E1'],
          ['Draft entries stay private', 'PUBLISH-01'],
          ['Archived entries remain readable', 'AUTH-HOST-01'],
        ].map(([claim, id]) => ({ file: 'docs/CLAIMS.md', line: claimSource.split('\n').findIndex(line => line.includes(`| ${claim} |`)) + 1, claim, clauses: [id] })) }
        await edit(root, 'claim-map.json', JSON.stringify(claimMap))
        succeeds(root, 'convert', '--old', 'HEAD', '--claim-map', 'claim-map.json')
        succeeds(root, 'coverage', 'check', '--old', 'HEAD')
        succeeds(root, 'id-map', '--old', 'HEAD')
        const converted = parseContract(await read(root, 'CONTRACT.md'))
        assert.deepEqual(converted.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })),
          old.clauses.map(({ id, status, evidence, gap, kind }) => ({ id, status, evidence, gap, kind })))
        assert.equal(converted.commit, old.commit)
        assert.equal(converted.date, old.date)
        const idMap = JSON.parse(await read(root, 'docs/contract/ID-MAP.json'))
        assert.equal(idMap.old, oldCommit)
        for (const clause of old.clauses) assert.ok(idMap.ids[clause.id].to.includes(clause.id), clause.id)
        const coveragePath = 'docs/contract/COVERAGE.json'
        const coverageText = await read(root, coveragePath)
        const coverage = JSON.parse(coverageText)
        assert.equal(coverage.old.commit, oldCommit)
        const statusTableLines = oldSource.split('\n').flatMap((line, index) => /^\| (Clauses|Published|Target and push further|All|Clause) \|/.test(line) ? [index + 1] : [])
        assert.ok(statusTableLines.length >= 5, 'the legacy fixture lost its Status tables')
        assert.ok(!coverage.fragments.some(fragment => fragment.file === 'CONTRACT.md' && statusTableLines.includes(fragment.line)), 'Status table headers and summary rows are carried by the ID map and status, not coverage')
        const claimsSource = await readFile(join(fixtures, 'legacy/docs/CLAIMS.md'), 'utf8')
        const optOutLine = claimsSource.split('\n').findIndex(line => line.includes('Do not sell entries')) + 1
        const optOut = coverage.fragments.filter(fragment => fragment.file === 'docs/CLAIMS.md' && fragment.line === optOutLine)
        assert.ok(optOut.length, 'the opt-out table row was not covered')
        assert.ok(optOut.every(fragment => fragment.section !== 'Homepage claims' && fragment.to !== 'generated'))
        const convertedText = await read(root, 'CONTRACT.md')
        const homepage = convertedText.split('## Homepage claims')[1].split('\n## ')[0]
        assert.ok(homepage.includes('Keep each entry\'s identity'), 'the larger handwritten homepage claims table was lost')
        assert.ok(!homepage.includes('Do not sell entries'), 'the opt-out row became a homepage claim')
        const verification = await read(root, 'docs/verify.md')
        assert.ok(verification.includes('The observer records any confusing empty states in the installation notes.'))
        const history = await read(root, 'CHANGELOG.md')
        assert.ok(history.includes('The studio keeps its original catalogue outside the installation.'))
        await generatedJourney(root)
        succeeds(root, 'coverage', 'check', '--old', 'HEAD')
        coverage.fragments.splice(0, 1)
        await edit(root, coveragePath, `${JSON.stringify(coverage, null, 2)}\n`)
        refuses(root, 'COVERAGE.json', 'coverage', 'check', '--old', 'HEAD')
        await edit(root, coveragePath, coverageText)
        succeeds(root, 'coverage', 'check', '--old', 'HEAD')
      })(),
    ])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  }
})
