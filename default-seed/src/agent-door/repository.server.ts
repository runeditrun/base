import { ToolRefusal, type Person } from '../../../modules/agent-door/index.ts'
import { newUlid } from '../core/platform/identifiers.server'

export function requirePeopleAccess(person: Person) {
  if (!person.active || !['owner', 'admin'].includes(person.role)) throw new ToolRefusal('operator_role_required')
}

type PersonRow = { id: string; name: string; email: string; details: string; created_at: string; import_revision: string | null }
export async function listPeople(db: D1Database) {
  const { results } = await db.prepare('SELECT id,name,email,details,created_at,import_revision FROM people ORDER BY id').all<PersonRow>()
  return results.map(row => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }))
}
export async function readPerson(db: D1Database, id: string) {
  const row = await db.prepare('SELECT id,name,email,details,created_at,import_revision FROM people WHERE id=?').bind(id).first<PersonRow>()
  if (!row) return null
  const notes = (await db.prepare('SELECT id,body,created_at FROM person_notes WHERE person_id=? ORDER BY id').bind(id).all()).results
  const files = (await db.prepare('SELECT id,name,content_type,size,created_at FROM person_files WHERE person_id=? ORDER BY id').bind(id).all()).results
  return { ...row, details: JSON.parse(row.details) as Record<string, unknown>, notes, files }
}

/** Reverse only the exact note that was saved, with native person attribution. */
export async function undoPersonNote(db: D1Database, actor: string, note: { id: string; personId: string; body: string }) {
  try {
    await db.batch([
      db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM person_notes WHERE id=? AND person_id=? AND body=?) THEN 1 ELSE json_extract('[]', '$[undo_evidence_changed') END").bind(note.id, note.personId, note.body),
      db.prepare('DELETE FROM person_notes WHERE id=? AND person_id=? AND body=?').bind(note.id, note.personId, note.body),
      db.prepare("INSERT INTO audit_events(id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,'note.removed','note',?,?,?)")
        .bind(newUlid(), actor, note.id, JSON.stringify({ personId: note.personId }), new Date().toISOString()),
    ])
  } catch (cause) {
    if (String(cause).includes('undo_evidence_changed')) throw new ToolRefusal('undo_evidence_changed')
    throw cause
  }
}

export interface OperatorRow { id: string; email: string; displayName: string; role: 'owner' | 'admin' | 'member'; status: 'active' | 'invited' | 'inactive'; version: number }
const operatorColumns = 'id,email,display_name AS displayName,role,status,version'
export function readOperator(db: D1Database, id: string) {
  return db.prepare(`SELECT ${operatorColumns} FROM oa_operators WHERE id=?`).bind(id).first<OperatorRow>()
}
export function operatorByEmail(db: D1Database, email: string) {
  return db.prepare(`SELECT ${operatorColumns} FROM oa_operators WHERE email=?`).bind(email.trim().toLowerCase()).first<OperatorRow>()
}

async function digest(rows: unknown) {
  const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)))
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Fingerprint the native records these actions can change. Credentials and the
 * agent door's own policy, audits and events are outside this business witness.
 * Import custody is included because erasing an imported person retires it. */
export async function witness(db: D1Database) {
  const native = ['people', 'person_notes', 'person_files', 'audit_events', 'person_erasure_redactions', 'oa_operators', 'oa_auth_audit', 'oa_tokens']
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'ik_%' OR name LIKE 'rer_erasure_%' OR name LIKE 'rer_portability_%') ORDER BY name").all<{ name: string }>()).results.map(row => row.name)
  const snapshots: Record<string, { rows: number; sha256: string }> = {}
  for (const table of [...native, ...tables]) {
    if (!/^[a-z_0-9]+$/.test(table)) throw new Error('Invalid native table name')
    const rows = (await db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results
    snapshots[table] = { rows: rows.length, sha256: await digest(rows) }
  }
  // Erasure removes historical development mail; only delivery IDs are read.
  const mail = (await db.prepare('SELECT id FROM rer_mail_development_outbox ORDER BY id').all()).results
  snapshots.rer_mail_development_outbox = { rows: mail.length, sha256: await digest(mail) }
  return { tables: snapshots }
}
