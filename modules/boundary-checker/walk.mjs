import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function sourceFiles(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { throw new Error(`Cannot read source root ${directory}: ${error.code ?? error.message}`) }
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(file))
    else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) &&
      (entry.isFile() || (entry.isSymbolicLink() && (await stat(file)).isFile()))) files.push(file)
  }
  return files
}
