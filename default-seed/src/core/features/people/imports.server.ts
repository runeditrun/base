import { canonicalJson, sha256 } from '../../../../../modules/import-kit/src/d1/index.ts'
import { personRedaction } from './person-redaction.server.ts'
import type { D1Database as KitDatabase, D1ImportContext, D1Sql, D1TargetAdapter, ImportMapping, Json, SourceBundle, TargetRow } from '../../../../../modules/import-kit/src/d1/index.ts'

/** People arrive through Base import-kit: each source row becomes one `people`
 * row, `import_revision` marks it as imported, and undo removes it again. */
export const PERSON = 'person'
// Parsed from a JSON request body, so details are JSON.
export interface ImportedPerson { ref: string; name: string; email: string; details: Record<string, unknown> }
type Value = { name: string; email: string; details: Record<string, unknown> }

const sql = (text: string, ...params: unknown[]): D1Sql => ({ sql: text, params })
const value = (row: TargetRow) => row.value as unknown as Value
type PersonRow = { id: string; name: string; email: string; details: string; import_revision: string | null }
const personRow = (row: PersonRow): TargetRow => ({ destination: 'people', targetKind: PERSON, targetId: row.id, revision: row.import_revision ?? '', value: { name: row.name, email: row.email, details: JSON.parse(row.details) } })

const utf8 = new TextEncoder()
const hex = (text: string) => { let out = ''; for (const byte of utf8.encode(text)) out += byte.toString(16).toUpperCase().padStart(2, '0'); return out }
const field = (text: string) => `${utf8.encode(text).length}:${text}`
const fieldsSql = ['id', 'name', 'email', 'details', 'import_revision'].map(column => `length(CAST(${column} AS BLOB))||':'||${column}`).join('||')
// SQLite orders TEXT by its UTF-8 bytes.
const byteOrder = (a: string, b: string) => {
  const x = utf8.encode(a), y = utf8.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}
/** The whole imported set as two exact predicates, however many people it holds:
 * its count, and every field of every row as length-prefixed UTF-8 bytes in id
 * order, compared as hex so no byte (U+0000 included) is lost in transport. */
export function personSet(rows: TargetRow[], where?: D1Sql): D1Sql[] {
  const scope = `import_revision IS NOT NULL${where ? ` AND ${where.sql}` : ''}`, params = where?.params ?? []
  const text = [...rows].sort((a, b) => byteOrder(a.targetId, b.targetId))
    .map(row => [row.targetId, String(value(row).name), String(value(row).email), canonicalJson(value(row).details), row.revision].map(field).join('')).join('')
  return [
    sql(`(SELECT count(*) FROM people WHERE ${scope})=?`, ...params, rows.length),
    sql(`(SELECT hex(CAST(coalesce(group_concat(${fieldsSql},'' ORDER BY id),'') AS BLOB)) FROM people WHERE ${scope})=?`, ...params, hex(text)),
  ]
}

export const personTargets: D1TargetAdapter = {
  async read(db, _destination, kind, id) {
    if (kind !== PERSON) return undefined
    const row = await db.prepare('SELECT id,name,email,details,import_revision FROM people WHERE id=?').bind(id).first<PersonRow>()
    return row ? personRow(row) : undefined
  },
  matches(row, _destination, _kind, id) {
    return row
      ? sql('EXISTS(SELECT 1 FROM people WHERE id=? AND name=? AND email=? AND details=? AND import_revision IS ?)', id, value(row).name, value(row).email, canonicalJson(value(row).details), row.revision || null)
      : sql('NOT EXISTS(SELECT 1 FROM people WHERE id=?)', id)
  },
  matchesCount(count) { return sql('(SELECT count(*) FROM people WHERE import_revision IS NOT NULL)=?', count) },
  matchesMany: (rows) => personSet(rows),
  write(row) {
    const { name, email, details } = value(row)
    return [sql("INSERT INTO people(id,name,email,details,created_at,import_revision) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,details=excluded.details,import_revision=excluded.import_revision",
      row.targetId, name, email, canonicalJson(details), row.revision)]
  },
  remove(_destination, _kind, id) { return [sql('DELETE FROM people WHERE id=?', id)] },
  redaction: (db, _destination, fields) => personRedaction(db, fields),
  // One query for the whole imported set, however many people it holds.
  async list(db) {
    const { results } = await db.prepare('SELECT id,name,email,details,import_revision FROM people WHERE import_revision IS NOT NULL ORDER BY id').all<PersonRow>()
    return results.map(personRow)
  },
}

export const peopleMapping: ImportMapping = { version: 'v1', map: (record) => ({ effects: [{ targetKind: PERSON, targetId: record.sourceId, value: record.payload }] }) }

/** One uploaded list: its exact bytes are kept as the import's original. */
export function peopleSource(people: ImportedPerson[]): SourceBundle {
  const payloads = people.map(({ name, email, details }) => ({ name, email, details: details as Record<string, Json> }))
  const bytes = canonicalJson(payloads), hash = sha256(bytes), encoded = new TextEncoder().encode(bytes)
  let binary = ''
  for (let i = 0; i < encoded.length; i += 0x8000) binary += String.fromCharCode(...encoded.subarray(i, i + 0x8000))
  return {
    diagnostics: [],
    artifacts: [{ name: 'people.json', sha256: hash, size: encoded.byteLength, original: { status: 'available', base64: btoa(binary) } }],
    records: payloads.map((payload, index) => ({ namespace: 'people', kind: 'person', sourceId: people[index].ref, payload, payloadHash: sha256(canonicalJson(payload)), artifactHash: hash, location: { artifact: 'people.json', row: index + 1 } })),
  }
}

/** Imports belong to an operator role, not to an operator row: an archive carries the jobs
 * but never the people who signed in, so a restored installation's owner is a new row with
 * the same role. Every call re-checks, inside its own D1 batch, that the operator is still
 * active in that role. Imports apply one person per batch. */
export function peopleImportContext(db: D1Database, operator: { id: string; role: string }, extra: Partial<D1ImportContext> = {}): D1ImportContext {
  return {
    destination: 'people', namespace: 'people', mappingVersion: 'v1', batchSize: 1,
    storage: { database: db as unknown as KitDatabase, targets: personTargets },
    authorization: { principalId: `role:${operator.role}`, predicate: () => sql("EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND status='active' AND role=? AND role IN ('owner','admin'))", operator.id, operator.role) },
    ...extra,
  }
}
