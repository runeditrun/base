import { fileURLToPath } from 'node:url'
import { runLocalBuild } from './base-onboarding/local/fixtures/build.mjs'

await runLocalBuild(fileURLToPath(new URL('../', import.meta.url)))
