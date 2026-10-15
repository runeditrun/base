import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

export async function rendererBoundaryProof() {
  const manifest = JSON.parse(await readFile(join(root, 'dist/server/.vite/manifest.json'), 'utf8'))
  const entry = Object.keys(manifest).find((id) => manifest[id].isEntry)
  const renderer = Object.keys(manifest).find((id) => manifest[id].src?.endsWith('/@tanstack/react-start/dist/default-entry/esm/server.js'))
  assert.ok(entry, 'the emitted Worker entry must be present')
  assert.ok(renderer, 'the actual Start renderer must remain a separate emitted module')
  // Inspect the complete emitted eager graph, including transitive imports. A
  // source-level dynamic import alone cannot establish that bundling kept this
  // boundary; the real document/runtime tests verify the lazy module still works.
  const eager = new Set()
  const visit = (id) => {
    if (eager.has(id)) return
    assert.ok(manifest[id], `emitted dependency ${id} must exist`)
    eager.add(id)
    for (const dependency of manifest[id].imports ?? []) visit(dependency)
  }
  visit(entry)
  assert.equal(eager.has(renderer), false, 'HTTP and event startup must not initialize the document renderer')
  assert.ok([...eager].some((id) => manifest[id].dynamicImports?.includes(renderer)), 'the Worker must retain its actual document renderer import')
}
