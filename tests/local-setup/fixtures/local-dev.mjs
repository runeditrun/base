import { fileURLToPath } from 'node:url'
import { runLocalDev } from './base-onboarding/local/fixtures/dev.mjs'

await runLocalDev(fileURLToPath(new URL('../', import.meta.url)))
