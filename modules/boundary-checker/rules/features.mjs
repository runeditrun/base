export function features({ config, file, add }, { target, specifier, node }) {
  const rule = config.rules.R3
  if (!rule.enabled || !target) return
  const from = /^src\/core\/features\/([^/]+)\//.exec(file)?.[1]
  const to = /^src\/core\/features\/([^/]+)\//.exec(target)?.[1]
  if (from && to && from !== to && ![`src/core/features/${to}/index.ts`, `src/core/features/${to}/index.tsx`, ...rule.exceptions].includes(target)) {
    add('R3', node, specifier, target, `feature ${from} must import ${to} through its public index`)
  }
}
