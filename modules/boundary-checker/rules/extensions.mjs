import { under } from '../paths.mjs'

export function extensions(context, edge) {
  const { config, file, add } = context
  const { target, specifier, node } = edge
  if (!target) return
  const one = config.rules.R1
  if (one.enabled && under(file, 'src/ext') && under(target, 'src/core') && !one.allowedPrefixes.some(prefix => under(target, prefix))) {
    add('R1', node, specifier, target, `ext may import only allowed core prefixes: ${specifier}`)
  }
  const two = config.rules.R2
  if (two.enabled && under(file, 'src/core') && under(target, 'src/ext')) {
    const allowed = Array.isArray(two.mounts) ? two.mounts.includes(file) :
      two.mounts[file] === true || (Array.isArray(two.mounts[file]) && two.mounts[file].includes(target))
    if (!allowed) add('R2', node, specifier, target, `core may not import extension module ${target} outside a declared mount`)
  }
}
