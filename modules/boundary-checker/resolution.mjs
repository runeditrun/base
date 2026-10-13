import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { projectPath } from './paths.mjs'

export function createResolver(root, config) {
  const require = createRequire(resolve(root, 'package.json'))
  let ts
  try { ts = require('typescript') }
  catch { throw new Error('Cannot resolve the project package typescript from package.json; install typescript in the project') }
  const configFile = resolve(root, config.tsconfig)
  const read = ts.readConfigFile(configFile, ts.sys.readFile)
  if (read.error) throw new Error(`Cannot read tsconfig ${config.tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile), undefined, configFile)
  const errors = parsed.errors.filter(error => error.code !== 18003)
  if (errors.length) throw new Error(`Invalid tsconfig ${config.tsconfig}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`)
  const cache = new Map()
  function resolveSpecifier(specifier, file) {
    const key = `${dirname(file)}\0${specifier}`
    if (!cache.has(key)) {
      const target = ts.resolveModuleName(specifier, file, parsed.options, ts.sys).resolvedModule?.resolvedFileName
      cache.set(key, target ? projectPath(root, ts.sys.realpath?.(target) ?? target) : null)
    }
    return cache.get(key)
  }
  return { ts, resolveSpecifier }
}
