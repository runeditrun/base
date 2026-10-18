import { z } from 'zod'
import { readImportDoorHistory, writeImportDoorSettings } from '../../../../../modules/import-kit/src/door/operator.ts'
import { schemaCurrent } from '../../../../../modules/import-kit/src/door/store.ts'
import { DoorError } from '../../../../../modules/import-kit/src/door/protocol.ts'
import type { D1Database as KitDatabase, D1Sql } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { Bindings } from '../../platform/bindings.server'
import { importOwnerPredicate, PEOPLE_DOOR_KEY } from './import-owner.server'

const settingsInput = z.object({ enabled: z.boolean(), revokedKids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(100).optional() }).strict()
const headers = { 'Cache-Control': 'no-store' }
const rows = (result: unknown) => (result as { results: Record<string, unknown>[] }).results
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
const assertOwner = (db: KitDatabase, owner: D1Sql) => db.prepare(`SELECT CASE WHEN (${owner.sql}) THEN 1 ELSE json('IMPORT_DOOR_OWNER_REQUIRED') END`).bind(...owner.params ?? [])

/** Initialize disabled via the kit's owner-fenced settings writer. A concurrent
 * enable must never be overwritten by a first-page settings read. */
export async function initializeImportSettings(db: KitDatabase, owner: D1Sql) {
  if (await db.prepare('SELECT 1 FROM ik_door_settings WHERE installation_id=?').bind(PEOPLE_DOOR_KEY).first()) return
  const initialOwner = { sql: `(${owner.sql}) AND NOT EXISTS(SELECT 1 FROM ik_door_settings WHERE installation_id=? AND enabled=1)`, params: [...owner.params ?? [], PEOPLE_DOOR_KEY] }
  try { await writeImportDoorSettings(db, PEOPLE_DOOR_KEY, { enabled: false }, initialOwner) }
  catch (error) {
    // A simultaneous settings approval won the race. Recheck current authority
    // and its committed row rather than issuing another settings write.
    const result = await db.batch([assertOwner(db, owner), db.prepare('SELECT 1 FROM ik_door_settings WHERE installation_id=? AND enabled=1').bind(PEOPLE_DOOR_KEY), assertOwner(db, owner)])
    if (!rows(result[1]).length) throw error
  }
}

export async function importOwnerResponse(request: Request, env: Bindings): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!['/api/operator/import-settings', '/api/operator/import-history', '/api/operator/import-export'].includes(path)) return null
  if ((path === '/api/operator/import-settings' && !['GET', 'POST'].includes(request.method)) || (path !== '/api/operator/import-settings' && request.method !== 'GET')) return json({ error: 'method_not_allowed' }, 405)
  const owner = await importOwnerPredicate(request, env)
  if (!owner) return json({ error: 'owner_required' }, 401)
  const db = env.DB as unknown as KitDatabase
  try {
    await schemaCurrent(db)
    await initializeImportSettings(db, owner)
    if (path === '/api/operator/import-settings') {
      if (request.method === 'POST') {
        const input = settingsInput.safeParse(await request.json().catch(() => null))
        if (!input.success) return json({ error: 'invalid_settings' }, 400)
        await writeImportDoorSettings(db, PEOPLE_DOOR_KEY, input.data, owner)
      }
      const result = await db.batch([assertOwner(db, owner),
        db.prepare('SELECT enabled FROM ik_door_settings WHERE installation_id=?').bind(PEOPLE_DOOR_KEY),
        db.prepare('SELECT kid FROM ik_door_revoked_keys WHERE installation_id=? ORDER BY kid').bind(PEOPLE_DOOR_KEY), assertOwner(db, owner)])
      return json({ enabled: rows(result[1])[0].enabled === 1, revokedKids: rows(result[2]).map(row => row.kid) })
    }
    if (path === '/api/operator/import-history') return json({ history: await readImportDoorHistory(db, PEOPLE_DOOR_KEY, owner) })
    // Native-created records belong in the same portable source format as imports.
    const result = await db.batch([assertOwner(db, owner), db.prepare('SELECT id AS ref,name,email,details FROM people ORDER BY id'), assertOwner(db, owner)])
    return json(rows(result[1]).map(row => ({ ...row, details: JSON.parse(String(row.details)) })))
  } catch (error) {
    return json({ error: error instanceof DoorError ? error.code : 'import_settings_conflict' }, error instanceof DoorError ? error.status : 409)
  }
}
