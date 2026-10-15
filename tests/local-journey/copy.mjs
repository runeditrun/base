import { access, cp } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

export const seedSource = fileURLToPath(new URL('../../', import.meta.url))
const base = resolve(seedSource, '..')
const excluded = new Set(['node_modules','dist','.wrangler','.dev.vars','.dev.vars.previous','.seed','.rer','.git','test-results','playwright-report'])
export async function copyProject(target) {
 let authorSource = false
 try { await access(resolve(base, 'onboarding/adapter.mjs')); await access(resolve(base, 'scripts/export-reference.mjs')); authorSource = true } catch (error) { if (error.code !== 'ENOENT') throw error }
 if (authorSource) {
  const { exportReference } = await import(pathToFileURL(resolve(base, 'scripts/export-reference.mjs')))
  await exportReference(base, target)
 } else await cp(seedSource, target, { recursive: true, filter: path => !excluded.has(basename(path)) && !basename(path).startsWith('.local-journey-') })
}
