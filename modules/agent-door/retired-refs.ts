import type { PolicyDocument } from './policy/document.ts'

/** Stable across archive restore; no raw reference is stored in suppression custody. */
export async function retiredDigest(ref: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rer-agent-retired-ref/1\n' + ref))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
const references = (document: PolicyDocument | null) => [...new Set([
  ...document?.rules.flatMap(rule => rule.approver ?? []) ?? [], ...document?.reviewers ?? [],
].filter(ref => ref.startsWith('person:')))]
export async function retiredMarker(db: D1Database, ref: string) {
  return db.prepare('SELECT marker FROM agent_door_retired_refs WHERE digest=?').bind(await retiredDigest(ref)).first<string>('marker')
}
/** All persisted JSON copies use the same exact-string retirement, including late completions. */
export async function retire(db: D1Database, value: unknown): Promise<string> {
  const text = JSON.stringify(value)
  // Most writes contain no policy principals; avoid work on the admission lease's hot path.
  if (!text.includes('"person:')) return text
  const markers = new Map<string, string>()
  const refs = new Set<string>()
  JSON.parse(text, (_key, item) => { if (typeof item === 'string' && /^person:[^\s:]{1,200}$/.test(item)) refs.add(item); return item })
  await Promise.all([...refs].map(async ref => { const marker = await retiredMarker(db, ref); if (marker) markers.set(ref, marker) }))
  return JSON.stringify(JSON.parse(text), (_key, item) => typeof item === 'string' ? markers.get(item) ?? item : item)
}
export async function pendingRetirement(db: D1Database, document: PolicyDocument | null) {
  const pending = await Promise.all(references(document).map(async ref => ref.startsWith('person:erased:') || !!await retiredMarker(db, ref)))
  return pending.filter(Boolean).length
}
