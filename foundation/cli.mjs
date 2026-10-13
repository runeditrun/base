#!/usr/bin/env node
import { initialize } from './initialize.mjs'
const options = {}
const names = { '--base-repo': 'baseRepo', '--ref': 'ref', '--output': 'output', '--family': 'family', '--edition': 'edition', '--repository': 'repository', '--site-domain': 'siteDomain' }
const args = process.argv.slice(2)
if (args.includes('--help')) { console.log('node foundation/cli.mjs --base-repo PATH --ref COMMIT --output NEW --family ID --edition ID --repository OWNER/REPO [--site-domain RUN-SITE-DOMAIN]'); process.exit(0) }
for (let i = 0; i < args.length; i += 2) {
  if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete option')
  options[names[args[i]]] = args[i + 1]
}
for (const key of Object.values(names)) if (key !== 'siteDomain' && !options[key]) throw new Error(`Missing ${key}`)
console.log(JSON.stringify(await initialize(options)))
