import { canonicalJson } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { D1Database as KitDatabase, D1FieldRedaction, D1RedactionScope, D1Sql, TargetRow } from '../../../../../modules/import-kit/src/d1/index.ts'

/** Field redaction for imported people that reads, fences and rewrites only the
 * rows holding an erased value, so erasing someone named in thousands of other
 * people's reactions costs a few packed statements instead of a few per row. */
const sql = (text: string, ...params: unknown[]): D1Sql => ({ sql: text, params })
const COLUMNS = ['name', 'email', 'details']
// Each packed statement binds one JSON array of rows, under D1's 2 MB value limit.
const CHUNK_BYTES = 900_000

/** SQL that is true when `people` holds `value` at `path`, with the kit's exact
 * semantics: `*` visits array items, string segments name object properties,
 * numeric segments select array indexes, and only an equal string leaf matches. */
function holds(path: readonly (string | number)[], value: string): D1Sql {
  const [column, ...rest] = path
  if (typeof column !== 'string' || !COLUMNS.includes(column)) return sql('0')
  if (column !== 'details') return rest.length ? sql('0') : sql(`people.${column}=?`, value)
  let depth = 0
  const walk = (json: string, at: number, jsonPath: string): D1Sql => {
    if (at === rest.length) return sql(`json_type(${json},?)='text' AND json_extract(${json},?)=?`, jsonPath, jsonPath, value)
    const segment = rest[at]
    if (typeof segment === 'number') return walk(json, at + 1, `${jsonPath}[${segment}]`)
    if (segment !== '*') {
      if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('UNSUPPORTED_REDACTION_PATH')
      return walk(json, at + 1, `${jsonPath}."${segment}"`)
    }
    const item = `j${depth++}`
    const inner = at + 1 === rest.length
      ? sql(`${item}.type='text' AND ${item}.value=?`, value)
      : walk(`${item}.value`, at + 1, '$')
    return sql(`json_type(${json},?)='array' AND EXISTS(SELECT 1 FROM json_each(${json},?) AS ${item} WHERE ${inner.sql})`, jsonPath, jsonPath, ...inner.params ?? [])
  }
  return walk('people.details', 0, '$')
}

const chunks = <T>(rows: T[]): T[][] => {
  const result: T[][] = []
  let current: T[] = [], size = 0
  for (const row of rows) {
    const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength
    if (current.length && size + bytes > CHUNK_BYTES) { result.push(current); current = []; size = 0 }
    current.push(row); size += bytes
  }
  if (current.length) result.push(current)
  return result
}
type Value = { name: string; email: string; details: Record<string, unknown> }
// One packed JSON array of row images as a table (bound once, joined by primary key).
const ROWS = "SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.name') AS name,json_extract(value,'$.email') AS email,json_extract(value,'$.details') AS details,json_extract(value,'$.revision') AS revision FROM json_each(?)"
const image = (row: TargetRow) => {
  const { name, email, details } = row.value as unknown as Value
  return { id: row.targetId, name, email, details: canonicalJson(details as never), revision: row.revision || null }
}

/** `exclude` removes a row being erased from the holding set once the batch
 * retires it (its native row stays for the bounded erasure that follows). */
export async function personRedaction(db: KitDatabase, fields: readonly D1FieldRedaction[], exclude?: D1Sql): Promise<D1RedactionScope> {
  const tests = fields.map(field => holds(field.path, field.value))
  const holding = sql(`import_revision IS NOT NULL AND (${tests.map(test => `(${test.sql})`).join(' OR ') || '0'})${exclude ? ` AND (${exclude.sql})` : ''}`,
    ...tests.flatMap(test => test.params ?? []), ...exclude?.params ?? [])
  const { results } = await db.prepare(`SELECT id,name,email,details,import_revision FROM people WHERE ${holding.sql} ORDER BY id`).bind(...holding.params ?? [])
    .all<{ id: string; name: string; email: string; details: string; import_revision: string }>()
  const rows: TargetRow[] = results.map(row => ({ destination: 'people', targetKind: 'person', targetId: row.id, revision: row.import_revision,
    value: { name: row.name, email: row.email, details: JSON.parse(row.details) } }))
  return {
    rows,
    // Exactly the selected rows hold a value: as many holders as selected, all selected.
    holding: selected => [sql(`(SELECT count(*) FROM people WHERE ${holding.sql})=? AND (SELECT count(*) FROM people WHERE ${holding.sql} AND id IN (SELECT value FROM json_each(?)))=?`,
      ...holding.params ?? [], selected.length, ...holding.params ?? [], JSON.stringify(selected.map(row => row.targetId)), selected.length)],
    matches: selected => chunks(selected.map(image)).map(part => sql(`(SELECT count(*) FROM (${ROWS}) AS j JOIN people ON people.id=j.id AND people.name IS j.name
      AND people.email IS j.email AND people.details IS j.details AND people.import_revision IS j.revision)=?`, JSON.stringify(part), part.length)),
    write: selected => chunks(selected.map(image)).map(part => sql(`UPDATE people SET name=j.name,email=j.email,details=j.details FROM (${ROWS}) AS j WHERE people.id=j.id`, JSON.stringify(part))),
  }
}
