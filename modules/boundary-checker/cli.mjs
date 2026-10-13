import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { checkBoundaries } from './index.mjs'
import { loadConfig } from './config.mjs'
import { report } from './reporter.mjs'

try {
  let configPath = resolve('boundaries.json'), json = false
  const args = process.argv.slice(2)
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--json' && !json) json = true
    else if (args[at] === '--config' && args[at + 1] && !args[at + 1].startsWith('--')) configPath = resolve(args[++at])
    else throw new Error(`Unknown or incomplete argument: ${args[at]}. Usage: node cli.mjs [--config <path>] [--json]`)
  }
  const config = await loadConfig(configPath)
  const result = await checkBoundaries({ root: existsSync(resolve(dirname(configPath), 'package.json')) ? dirname(configPath) : process.cwd(), config })
  const output = json ? JSON.stringify(result, null, 2) : report(result)
  if (result.violations.length) { console.error(output); process.exitCode = 1 }
  else console.log(output)
} catch (error) {
  console.error(`Boundary check configuration error: ${error.message}`)
  process.exitCode = 2
}
