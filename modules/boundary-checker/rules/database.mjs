import { matches, modulePath, under } from '../paths.mjs'

export function database({ config, file, add }, { target, specifier, node }) {
  const rule = config.rules.R4
  if (!rule.enabled) return
  const restricted = rule.specifiers.includes(specifier) || rule.specifierPrefixes.some(prefix => specifier.startsWith(prefix)) ||
    (target && rule.clientModules.some(client => modulePath(client) === modulePath(target)))
  if (restricted && !matches(file, rule.allowedFiles) && !rule.allowedDirectories.some(directory => under(file, directory))) {
    add('R4', node, specifier, target, `database imports are allowed only in repositories or allowed directories: ${specifier}`)
  }
}
