import { cp, mkdir, mkdtemp, rm, symlink, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const typescript = process.env.BOUNDARY_TYPESCRIPT ?? resolve(moduleRoot, '../../default-seed/node_modules/typescript')
export const cli = resolve(moduleRoot, 'cli.mjs')
export async function project(t, fixture = 'clean', { linkTypescript = true, temporaryDirectory = tmpdir() } = {}) {
  const parent = await mkdtemp(resolve(temporaryDirectory, 'boundary-project-'))
  const root = resolve(parent, 'seed')
  t.after(() => rm(parent, { recursive: true, force: true }))
  await cp(resolve(moduleRoot, 'tests/fixtures', fixture), root, { recursive: true })
  if (linkTypescript) {
    await mkdir(resolve(root, 'node_modules'), { recursive: true })
    await symlink(typescript, resolve(root, 'node_modules/typescript'), 'dir')
  }
  return await realpath(root)
}
export async function put(root, file, content) {
  await mkdir(dirname(resolve(root, file)), { recursive: true })
  await writeFile(resolve(root, file), content)
}
export function run(root, args = [], script = cli) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } })
}
export const findings = result => result.violations.map(({ rule, file, line }) => [rule, file, line])
export async function example(name) { return JSON.parse(await readFile(resolve(moduleRoot, 'examples', `${name}.json`), 'utf8')) }
