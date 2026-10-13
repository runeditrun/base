import { test } from 'node:test'
import { resolve } from 'node:path'
import { checkIncremental } from '../../../foundation/template/tests/typecheck-checks.mjs'

test('default-seed incremental typecheck', async t => {
 const context = resolve(import.meta.dirname, '../../..')
 await checkIncremental(t, resolve(context, 'default-seed'), {
  context, extraSources: ['modules', 'onboarding', 'foundation/runtime'],
 })
})
