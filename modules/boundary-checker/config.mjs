import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { glob } from './paths.mjs'

export const defaults = {
  version: 1, sourceRoot: 'src', tsconfig: 'tsconfig.json', includeTypeOnly: true,
  rules: {
    R1: { enabled: true, allowedPrefixes: ['src/core/api', 'src/core/shared'] },
    R2: { enabled: true, mounts: [] },
    R3: { enabled: true, exceptions: [] },
    R4: { enabled: true, specifiers: ['drizzle-orm/d1'], specifierPrefixes: [], clientModules: [],
      allowedFiles: ['**/repository.ts', '**/*-repository.ts'], allowedDirectories: [] },
    R5: { enabled: true, importScopes: ['**'], environmentScopes: ['src/core/**'],
      specifierPatterns: ['cloudflare:*'], allowedDirectories: ['src/core/platform', 'src/core/app'] },
    R6: { enabled: true },
    R7: { enabled: true, files: [], pattern: '(server|repository|service)\\.[cm]?[jt]sx?$' },
    R8: { enabled: false, files: [], prefix: '/**' },
  },
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`)
}
function keys(value, allowed, label) {
  object(value, label)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown key ${key}`)
}
function string(value, label) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new Error(`${label}: expected a nonempty string`)
}
function path(value, label) {
  string(value, label)
  if (isAbsolute(value) || /[\\:*?\[\]{}]/.test(value) || value.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error(`${label}: expected a relative POSIX path without traversal`)
  }
}
function strings(value, label, validate = string) {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`)
  value.forEach((entry, at) => validate(entry, `${label}[${at}]`))
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label}: expected a boolean`)
}

export function validateConfig(input) {
  keys(input, Object.keys(defaults), 'config')
  if (input.version !== 1) throw new Error('config.version: expected 1')
  const result = structuredClone(defaults)
  for (const field of ['sourceRoot', 'tsconfig']) if (field in input) { path(input[field], field); result[field] = input[field] }
  if ('includeTypeOnly' in input) { boolean(input.includeTypeOnly, 'includeTypeOnly'); result.includeTypeOnly = input.includeTypeOnly }
  if ('rules' in input) keys(input.rules, Object.keys(defaults.rules), 'rules')
  for (const [rule, supplied] of Object.entries(input.rules ?? {})) {
    if (supplied === false) { result.rules[rule].enabled = false; continue }
    keys(supplied, Object.keys(defaults.rules[rule]), rule)
    result.rules[rule] = { ...result.rules[rule], ...structuredClone(supplied) }
  }
  for (const [rule, options] of Object.entries(result.rules)) {
    for (const [key, value] of Object.entries(options)) {
      const label = `${rule}.${key}`
      if (key === 'enabled') boolean(value, label)
      else if (key === 'mounts') {
        if (Array.isArray(value)) strings(value, label, path)
        else {
          object(value, label)
          for (const [mount, targets] of Object.entries(value)) {
            path(mount, label)
            if (targets !== true) strings(targets, `${label}.${mount}`, path)
          }
        }
      } else if (key === 'pattern') {
        string(value, label)
        try { new RegExp(value) } catch { throw new Error(`${label}: invalid regular expression`) }
      } else if (key === 'prefix') string(value, label)
      else if (['allowedFiles', 'files', 'importScopes', 'environmentScopes', 'specifierPatterns'].includes(key)) strings(value, label, glob)
      else if (['specifiers', 'specifierPrefixes'].includes(key)) strings(value, label)
      else strings(value, label, path)
    }
  }
  return result
}

export async function loadConfig(file) {
  let input
  try { input = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { throw new Error(`Cannot read JSON config ${file}: ${error.code ?? error.message}`) }
  return validateConfig(input)
}
