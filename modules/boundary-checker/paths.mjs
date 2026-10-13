import { isAbsolute, relative, sep } from 'node:path'

export function projectPath(root, file, { ignoreDependencies = true } = {}) {
  const path = relative(root, file)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return null
  const shown = path.split(sep).join('/')
  return ignoreDependencies && shown.split('/').includes('node_modules') ? null : shown
}

export function under(file, directory) {
  return file.startsWith(`${directory}/`)
}

export function modulePath(file) {
  return file.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, '')
}

// Deliberately small glob language: *, ?, and a whole-segment **.
export function glob(pattern, label = 'glob') {
  if (typeof pattern !== 'string' || !pattern || /[\\\[\]{}!\x00-\x1f]/.test(pattern) ||
      pattern.startsWith('/') || pattern.split('/').some(part => !part || part === '.' || part === '..' || (part.includes('**') && part !== '**'))) {
    throw new Error(`${label}: invalid glob`)
  }
  let expression = '^'
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]
    if (char === '*' && pattern[at + 1] === '*') {
      at++
      if (pattern[at + 1] === '/') { expression += '(?:.*/)?'; at++ }
      else expression += '.*'
    } else if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}

export function matches(file, patterns) {
  return patterns.some(pattern => glob(pattern).test(file))
}

export function matchesSpecifier(specifier, patterns) {
  return patterns.some(pattern => new RegExp(glob(pattern).source.replaceAll('[^/]', '.')).test(specifier))
}
