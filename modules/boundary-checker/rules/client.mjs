import { matches } from '../paths.mjs'

export function client({ config, file, add }, { target, specifier, node }) {
  const rule = config.rules.R7
  if (rule.enabled && target && matches(file, rule.files) && new RegExp(rule.pattern).test(target)) {
    add('R7', node, specifier, target, `client entry imports server code: ${specifier}`)
  }
}
