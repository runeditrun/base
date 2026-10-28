import { runRows } from '../rows.mjs'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { checkIncremental } from '../../../foundation/template/tests/typecheck-checks.mjs'

test('default-seed incremental typecheck', async t => {
 const context = resolve(import.meta.dirname, '../../..')
 const rows = []
 await checkIncremental({ after: hook => t.after(hook), test: (name, run) => rows.push([name, {}, run]) }, resolve(context, 'default-seed'), {
  context, extraSources: ['modules', 'onboarding', 'foundation/runtime'],
 })
 await runRows(t, rows)
})
