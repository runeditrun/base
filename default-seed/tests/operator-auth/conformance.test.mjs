import { runRows } from '../rows.mjs'
import { test } from 'node:test'
import { registerOperatorAuthConformance } from '../../../modules/operator-auth/conformance/index.mjs'
import { openConsumerRuntime } from './runtime.mjs'
const rows = []
registerOperatorAuthConformance({ test: (name, run) => rows.push([name, {}, run]), adapter: { open: openConsumerRuntime, confirmationFonts: true, branding: { productName: 'Default seed reference', theme: '/rer-theme.css' } } })

test("native operator authentication retains bootstrap, confirmation, administration and mail refusal", async t => {
  await runRows(t, rows)
})
