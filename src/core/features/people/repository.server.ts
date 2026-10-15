import { newUlid } from '../../platform/identifiers.server'

export interface PersonInput { name: string; email: string; details: Record<string, unknown> }

const now = () => new Date().toISOString()
function base64(bytes: Uint8Array) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
const auditStatement = (db: D1Database, actor: string, action: string, entityType: string, entityId: string, details: unknown) =>
  db.prepare('INSERT INTO audit_events(id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(newUlid(), actor, action, entityType, entityId, JSON.stringify(details), now())

export async function personExists(db: D1Database, id: string) {
  return Boolean(await db.prepare('SELECT 1 FROM people WHERE id=?').bind(id).first())
}

export async function createPerson(db: D1Database, actor: string, input: PersonInput) {
  const id = newUlid()
  await db.batch([
    db.prepare('INSERT INTO people(id,name,email,details,created_at) VALUES(?,?,?,?,?)').bind(id, input.name, input.email, JSON.stringify(input.details), now()),
    auditStatement(db, actor, 'person.created', 'person', id, { name: input.name, email: input.email }),
  ])
  return id
}

export async function addNote(db: D1Database, actor: string, personId: string, body: string) {
  const id = newUlid()
  await db.batch([
    db.prepare('INSERT INTO person_notes(id,person_id,body,created_at) VALUES(?,?,?,?)').bind(id, personId, body, now()),
    auditStatement(db, actor, 'note.added', 'note', id, { excerpt: body.slice(0, 80) }),
  ])
  return id
}

/** Storage keys are opaque: a file name never reaches R2 or the erasure work list. */
export async function attachFile(db: D1Database, bucket: R2Bucket, actor: string, personId: string, file: { name: string; contentType: string; bytes: ArrayBuffer }) {
  const id = newUlid(), key = `people/${newUlid()}`
  await bucket.put(key, file.bytes, { httpMetadata: { contentType: file.contentType } })
  try {
    await db.batch([
      db.prepare('INSERT INTO person_files(id,person_id,name,content_type,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id, personId, file.name, file.contentType, file.bytes.byteLength, key, now()),
      auditStatement(db, actor, 'file.attached', 'file', id, { name: file.name }),
    ])
  } catch (error) {
    await bucket.delete(key)
    throw error
  }
  return id
}

/** The subject's own export: profile, notes and files with their bytes. */
export async function exportPerson(db: D1Database, bucket: R2Bucket, id: string) {
  const person = await db.prepare('SELECT id,name,email,details,created_at FROM people WHERE id=?').bind(id).first<Record<string, string>>()
  if (!person) return null
  const notes = (await db.prepare('SELECT id,body,created_at FROM person_notes WHERE person_id=? ORDER BY id').bind(id).all()).results
  const rows = (await db.prepare('SELECT id,name,content_type,size,storage_key,created_at FROM person_files WHERE person_id=? ORDER BY id').bind(id).all<Record<string, string | number>>()).results
  const files = []
  for (const { storage_key: key, ...file } of rows) {
    const object = await bucket.get(String(key))
    files.push({ ...file, base64: object ? base64(new Uint8Array(await object.arrayBuffer())) : null })
  }
  return { person: { ...person, details: JSON.parse(person.details) }, notes, files }
}

export function erasureRequestedStatement(db: D1Database, actor: string, id: string) {
  return auditStatement(db, actor, 'person.erasure_requested', 'person', id, {})
}
