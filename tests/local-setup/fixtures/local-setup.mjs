import { fileURLToPath } from 'node:url'
import { runLocalSetup } from './base-onboarding/local/fixtures/setup.mjs'
import { parseAddress } from './base-cli/modules/mail/src/core/validation.mjs'

await runLocalSetup(fileURLToPath(new URL('../', import.meta.url)), { parseAddress, database: 'default-seed-reference' })
