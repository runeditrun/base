import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateAgentSurface } from '../conformance/surface.mjs'
import { registry } from '../registry.ts'

test('narrowing declarations reject grant-adding schemas and retain widening coverage', async t => {
 const surface = JSON.parse(await readFile(new URL('../../../default-seed/agent-surface.json', import.meta.url), 'utf8'))
 const checked = validateAgentSurface(surface)
 assert.deepEqual(checked.points.filter((point: any) => !point.ok), [])
 assert.ok(checked.points.some((point: any) => point.id.includes('base.access.demote.uses-narrowing-check')))
 const demote = surface.tools.find((tool: any) => tool.name === 'base.access.demote')
 demote.inputSchema.properties.grants_to_add = { type: 'array', items: { type: 'string' } }
 const negative = validateAgentSurface(surface)
 assert.ok(negative.points.some((point: any) => !point.ok && point.id.includes('base.access.demote.narrowing-contract')))
 // Exercise the production registry too: an adopter cannot hide the widening
 // input in application code while publishing a target-only surface schema.
 const tool = { ...demote, title: 'Demote', description: 'Native demotion', outputSchema: true, classify() {}, run() {}, authority() {}, summary() {} }
 assert.throws(() => registry({ seed: 'base', origin: 'https://app.invalid', resources: [], tools: [{ ...tool, inputSchema: demote.inputSchema }] } as any), /Invalid narrowing contract/)
 t.diagnostic('Gap N declaration checks: 4/4; widening escalation fixtures retained; grant-adding schema refused by surface and runtime')
})
