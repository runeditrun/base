import { matches } from '../paths.mjs'

export function header({ config, file, source, add }) {
  const rule = config.rules.R8
  if (rule.enabled && matches(file, rule.files) && !source.text.startsWith(rule.prefix)) {
    add('R8', null, null, null, `owner file must start with ${rule.prefix}`)
  }
}
