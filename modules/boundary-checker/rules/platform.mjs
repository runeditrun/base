import { matches, matchesSpecifier, under } from '../paths.mjs'

export function platformImport({ config, file, add }, { specifier, target, node }) {
  const rule = config.rules.R5
  if (rule.enabled && matches(file, rule.importScopes) && matchesSpecifier(specifier, rule.specifierPatterns) &&
      !rule.allowedDirectories.some(directory => under(file, directory))) {
    add('R5', node, specifier, target, `platform import outside allowed directories: ${specifier}`)
  }
}

export function platformRead({ ts, config, file, add }, node) {
  const rule = config.rules.R5
  if (!rule.enabled || !matches(file, rule.environmentScopes) || rule.allowedDirectories.some(directory => under(file, directory))) return
  if (ts.isPropertyAccessExpression(node) && (node.name.text === 'env' ||
      (ts.isIdentifier(node.expression) && ['env', 'environment'].includes(node.expression.text)))) {
    add('R5', node, null, null, 'environment binding read outside allowed directories')
  }
}
