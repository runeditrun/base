export function report(result) {
  if (!result.violations.length) return `Boundary check passed for ${result.files} source files.`
  return [`Boundary check failed with ${result.violations.length} violation(s):`,
    ...result.violations.map(item => `- ${item.file}:${item.line} ${item.rule}: ${item.message}`)].join('\n')
}
