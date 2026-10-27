import { caseRows } from '../onboarding/test-fixture.mjs';
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ContractError, parseContract } from './runtime/seed-contract.mjs'

// Slate's CONTRACT.md as just-every/run-slate main had it at e60b107, the first
// contract in the canonical shape.
const slate = await readFile(join(import.meta.dirname, 'fixtures/slate-contract-e60b107.md'), 'utf8')
const lines = slate.split('\n')
const lineOf = (text, from = 0) => lines.findIndex((line, index) => index >= from && line.startsWith(text)) + 1
const statusLine = lineOf('## Status'), headerLine = lineOf('| Clause | Title |', statusLine)
const rowLine = id => lineOf(`| \`${id}\` |`, headerLine)
const edit = (change, text = slate) => { const copy = text.split('\n'); change(copy); return copy.join('\n') }
const problems = text => {
  try { parseContract(text) } catch (error) { assert.ok(error instanceof ContractError, error.stack); return error.problems }
  assert.fail('the contract parsed')
}
const refuses = (text, line, pattern) => {
  const found = problems(text)
  assert.ok(found.some(problem => problem.line === line && pattern.test(problem.message)), `expected line ${line} ${pattern}, got ${JSON.stringify(found)}`)
}

test("contract parsing retains clause identities, row counts and source-linked refusal diagnostics", t => caseRows(t, [
  ["Slate's contract parses into its target, areas and one clause per Status row, counted from the rows", () => {
  const contract = parseContract(slate)
  const rows = lines.slice(headerLine + 1).filter(line => line.startsWith('| `')).map(line => line.split('|').map(cell => cell.trim()))
  const tally = status => rows.filter(row => row[4] === status).length
  assert.deepEqual(contract.counts, { done: tally('done'), partial: tally('partial'), missing: tally('missing'), total: rows.length })
  assert.equal(contract.clauses.length, rows.length)
  assert.deepEqual(contract.clauses.map(clause => clause.id), rows.map(row => row[1].replaceAll('`', '')))
  const judged = /commit `([0-9a-f]+)`/.exec(lines[statusLine + 1])[1]
  assert.equal(contract.commit, judged)
  assert.match(contract.date, /^\d{4}-\d{2}-\d{2}$/)
  for (const value of [contract.target.category, contract.target.firstBuyer, ...contract.target.incumbents]) assert.ok(value.length)
  assert.ok(contract.target.incumbents.length > 1)
  assert.deepEqual(contract.areas.flatMap(area => area.clauses).sort(), contract.clauses.map(clause => clause.id).sort())
  for (const key of ['done', 'partial', 'missing', 'total']) assert.equal(contract.areas.reduce((sum, area) => sum + area[key], 0), contract.counts[key])
  const targetLine = lineOf('## Target clauses')
  const definedAt = id => contract.clauses.find(clause => clause.id === id).line
  for (const area of contract.areas) assert.equal(area.group, definedAt(area.clauses[0]) > targetLine ? 'target' : 'published', area.name)
  assert.ok(contract.areas.some(area => area.group === 'target') && contract.areas.some(area => area.group === 'published'))
  const home = contract.clauses.find(clause => clause.id === 'HOME-001')
  assert.equal(home.row, rowLine('HOME-001'))
  assert.equal(home.line, lineOf('- **HOME-001 — '))
  assert.equal(home.area, 'Public landing')
  for (const clause of contract.clauses) if (clause.status !== 'missing') assert.ok(clause.evidence.length, clause.id)
}],
  ['two-digit AREA-NN and legacy E1-style clause IDs parse; other shapes still refuse at their line', () => {
  const home = rowLine('HOME-001')
  const renamed = (from, to) => slate.replaceAll(from, to)
  const contract = parseContract(renamed('DOCS-001', 'E1').replaceAll('HOME-001', 'PAN-01'))
  assert.ok(contract.clauses.some(clause => clause.id === 'PAN-01' && clause.row === home))
  assert.ok(contract.clauses.some(clause => clause.id === 'E1'))
  for (const bad of ['E', 'PAN-1234', 'pan-01']) refuses(edit(copy => { copy[home - 1] = copy[home - 1].replace('HOME-001', bad) }), home, /not a clause ID/)
}],
  ['a malformed or inconsistent contract is refused, naming the line of each problem', () => {
  const home = rowLine('HOME-001'), docs = rowLine('DOCS-001'), collab = rowLine('COLLAB-004')
  refuses(edit(copy => { copy[statusLine - 1] = '## State' }), lines.length, /## Status/)
  refuses(edit(copy => { copy[statusLine + 1] = 'Judged at an unknown commit.' }), statusLine + 2, /Judged from/)
  refuses(edit(copy => { copy[statusLine + 1] = copy[statusLine + 1].replace(/\([^)]+\)/, '(31 February 2026)') }), statusLine + 2, /31 February 2026/)
  refuses(edit(copy => { copy[headerLine - 1] = '| Clause | Status | Evidence | Title | Kind | Gap |' }), headerLine, /header/)
  refuses(edit(copy => { copy[home - 1] = copy[home - 1].replace('| published |', '| shipped |') }), home, /HOME-001.*shipped/)
  refuses(edit(copy => { copy[home - 1] = copy[home - 1].replace('| done |', '| finished |') }), home, /HOME-001.*finished/)
  refuses(edit(copy => { copy.splice(docs, 0, copy[home - 1]) }), docs + 1, new RegExp(`HOME-001.*line ${home}\\b`))
  refuses(edit(copy => { copy.splice(docs - 1, 1) }), lineOf('- **DOCS-001 — '), /DOCS-001/)
  refuses(edit(copy => { copy.splice(docs, 0, '| `ZZZ-001` | Nothing | published | done | `README.md` |  |') }), docs + 1, /ZZZ-001/)
  refuses(edit(copy => { copy[home - 1] = copy[home - 1].replace('Public landing', 'Landing') }), home, /HOME-001.*Landing/)
  refuses(edit(copy => { copy[collab - 1] = copy[collab - 1].replace('| missing |', '| done |').replace(/\|\s*\|([^|]*)\|$/, '| `README.md` |$1|') }), collab, /COLLAB-004.*missing/)
  refuses(edit(copy => { copy[home - 1] = copy[home - 1].replace('`tests/e2e/landing-styles.test.mjs`', '') }), home, /HOME-001.*Evidence/)
  const all = lineOf('| All |', statusLine)
  refuses(edit(copy => { copy[all - 1] = copy[all - 1].replace(/\| (\d+) \|$/, (_, total) => `| ${Number(total) + 1} |`) }), all, /All/)
  // Every problem is reported at once, in line order.
  const both = problems(edit(copy => { copy[home - 1] = copy[home - 1].replace('| done |', '| finished |'); copy[docs - 1] = copy[docs - 1].replace('| published |', '| shipped |') }))
  assert.deepEqual(both.map(problem => problem.line), [home, docs])
}]
]));
