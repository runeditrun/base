import { createErasure, defineErasure, toD1Sql } from '../../../../../modules/erasure/index.mjs'
import { createPortability } from '../../../../../modules/portability/index.mjs'
import { portabilityPolicy } from '../../platform/portability-policy.mjs'
import { erasureFenceStatements } from '../../../../../modules/agent-door/index.ts'

/** The reference declaration a seed copies: every table holding the person, the
 * file bytes, the audit references, and the seed's own extra statements. */
export const personErasure = defineErasure({
  entity: 'person',
  root: { table: 'people' },
  edges: [
    { table: 'person_notes', from: 'people', on: { person_id: 'id' } },
    { table: 'person_files', from: 'people', on: { person_id: 'id' }, blob: { bucket: 'FILES', keyColumn: 'storage_key' } },
    { table: 'person_erasure_redactions', from: 'people', on: { person_id: 'id' } },
  ],
  audit: [
    { table: 'audit_events', column: 'entity_id', of: 'people', where: "entity_type='person'", clear: { details: '{}' } },
    { table: 'audit_events', column: 'entity_id', of: 'person_notes', where: "entity_type='note'", clear: { details: '{}' } },
    { table: 'audit_events', column: 'entity_id', of: 'person_files', where: "entity_type='file'", clear: { details: '{}' } },
  ],
  // Historical development mail is addressed to the person.
  async statements({ db, subject }) {
    const person = await db.prepare('SELECT email FROM people WHERE id=?').bind(subject.id).first<{ email: string }>()
    return [
      ...erasureFenceStatements(db, { uris: [`base://person/${encodeURIComponent(String(subject.id))}`] }),
      ...person ? [db.prepare("DELETE FROM rer_mail_development_outbox WHERE EXISTS(SELECT 1 FROM json_each(json_extract(message,'$.to')) WHERE lower(value)=lower(?))").bind(person.email)] : [],
    ]
  },
})

export async function peopleErasure(db: D1Database, files: R2Bucket) {
  const portability = await createPortability({ db, buckets: { FILES: files }, policy: portabilityPolicy })
  return createErasure({ db, buckets: { FILES: files }, portability, declarations: [personErasure] })
}

/** Portability's redaction checkpoint, as import-kit statements. The batch that
 * rewrites or retires import custody carries it, so `rer import --journal LATER`
 * refuses every archive older than the erasure whole, even one with no native row
 * of the person. `transfers` also drops in-flight export copies, for a batch that
 * does not already carry the erasure's native statements. */
export async function custodyCheckpoint(db: D1Database, files: R2Bucket, transfers: boolean) {
  const portability = await createPortability({ db, buckets: { FILES: files }, policy: portabilityPolicy })
  return [...transfers ? await portability.invalidateTransfersStatements() : [], ...await portability.redactionStatements()].map(toD1Sql)
}
