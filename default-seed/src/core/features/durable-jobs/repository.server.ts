import { z } from 'zod'
import type { Database, Sql } from '../../../../../modules/durable-jobs/src/types.ts'
import { saleRow, salesInput, salesRevision, tenantKey } from './codecs.server.ts'

const identifier = z.string().min(1).max(100)

/** Trusted server-side source ingestion. HTTP job callers cannot provision
 * memberships, invent a revision, or supply rows through the job intent. */
export function createSalesRepository(database: Database, installationId: string) {
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/).parse(installationId)
  const scope = (tenantId: string | null) => [installationId, tenantKey(tenantId)]
  return {
    async createTenant(tenantId: string | null, ownerId: string) {
      if (tenantId !== null) identifier.parse(tenantId)
      identifier.parse(ownerId)
      await database.atomic([{ sql: 'INSERT INTO reference_sales_tenants(installation_id,tenant_key,owner_id,active) VALUES(?,?,?,1)', params: [...scope(tenantId), ownerId] }])
    },
    async setMembership(tenantId: string | null, principalId: string, active: boolean) {
      identifier.parse(principalId)
      await database.atomic([{ sql: `INSERT INTO reference_sales_memberships(installation_id,tenant_key,principal_id,active) VALUES(?,?,?,?)
        ON CONFLICT(installation_id,tenant_key,principal_id) DO UPDATE SET active=excluded.active`, params: [...scope(tenantId), principalId, Number(active)] }])
    },
    async beginRevision(tenantId: string | null, sourceId: string, revision: string) {
      salesInput.parse({ sourceId }); salesRevision.parse({ sourceRevision: revision })
      await database.atomic([
        { sql: `INSERT INTO reference_sales_sources(installation_id,tenant_key,source_id,current_revision,active) VALUES(?,?,?,NULL,1)
          ON CONFLICT(installation_id,tenant_key,source_id) DO NOTHING`, params: [...scope(tenantId), sourceId] },
        { sql: "INSERT INTO reference_sales_revisions(installation_id,tenant_key,source_id,revision,state) VALUES(?,?,?,?,'draft')", params: [...scope(tenantId), sourceId, revision] },
      ])
    },
    async appendRows(tenantId: string | null, sourceId: string, revision: string, input: unknown) {
      salesInput.parse({ sourceId }); salesRevision.parse({ sourceRevision: revision })
      const rows = z.array(saleRow).min(1).max(100).parse(input)
      await database.atomic(rows.map(row => ({ sql: `INSERT INTO reference_sales_rows(installation_id,tenant_key,source_id,revision,ordinal,sale_id,amount_minor,currency)
        VALUES(?,?,?,?,?,?,?,?)`, params: [...scope(tenantId), sourceId, revision, row.ordinal, row.saleId, row.amountMinor, row.currency] })))
    },
    async publishRevision(tenantId: string | null, sourceId: string, revision: string) {
      salesInput.parse({ sourceId }); salesRevision.parse({ sourceRevision: revision })
      const params = [...scope(tenantId), sourceId, revision]
      await database.atomic([
        { sql: `UPDATE reference_sales_revisions SET state='ready',
            row_count=(SELECT count(*) FROM reference_sales_rows x WHERE x.installation_id=? AND x.tenant_key=? AND x.source_id=? AND x.revision=?),
            total_minor=(SELECT COALESCE(sum(amount_minor),0) FROM reference_sales_rows x WHERE x.installation_id=? AND x.tenant_key=? AND x.source_id=? AND x.revision=?)
          WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND state='draft'`, params: [...params, ...params, ...params] },
        { sql: `UPDATE reference_sales_sources SET current_revision=?,active=1 WHERE installation_id=? AND tenant_key=? AND source_id=?
          AND EXISTS(SELECT 1 FROM reference_sales_revisions WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND state='ready')`,
          params: [revision, ...scope(tenantId), sourceId, ...params] },
      ])
    },
    async eraseSource(tenantId: string | null, sourceId: string) {
      salesInput.parse({ sourceId })
      const params = [...scope(tenantId), sourceId]
      const statements: Sql[] = [
        { sql: 'UPDATE reference_sales_sources SET active=0 WHERE installation_id=? AND tenant_key=? AND source_id=?', params },
        { sql: "UPDATE reference_sales_revisions SET state='erased' WHERE installation_id=? AND tenant_key=? AND source_id=?", params },
        { sql: 'DELETE FROM reference_sales_rows WHERE installation_id=? AND tenant_key=? AND source_id=?', params },
        { sql: 'DELETE FROM reference_sales_published_rows WHERE installation_id=? AND tenant_key=? AND source_id=?', params },
        { sql: 'DELETE FROM reference_sales_results WHERE installation_id=? AND tenant_key=? AND source_id=?', params },
      ]
      await database.atomic(statements)
    },
  }
}
