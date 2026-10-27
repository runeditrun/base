import { test } from 'node:test'
import { runRows } from '../rows.mjs'
import { cancellationRows } from './cancellation.mjs'
import { recoveryRows } from './hard-kill.mjs'

// Graceful signals and hard kills are two interruption modes of the same
// private-credential lifecycle. Rows keep each mode's assertions and cleanup.
test('interrupted local operations restore exact private originals and stop only owned descendants', async t => {
  await runRows(t, [...cancellationRows, ...recoveryRows])
})
