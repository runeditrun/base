import type { Database, Job, JobKind, Sql } from '../../../../../modules/durable-jobs/src/types.ts'
import { SALES_KIND, salesCheckpoint, salesInput, salesResult, salesRevision, tenantKey } from './codecs.server.ts'
import { predicate, salesRevisionGuard } from './policy.server.ts'

/** Materialize a bounded page of actual persisted USD sales. Both the page and
 * its cursor enter the shared job transaction; no intermediate page is a result. */
export function createSalesKind(database: Database): JobKind {
  const scope = (job: Job) => {
    const { sourceId } = salesInput.parse(job.inputRef), { sourceRevision } = salesRevision.parse(job.requestedRevision)
    return { sourceId, sourceRevision, params: [job.installationId, tenantKey(job.tenantId), sourceId, sourceRevision] }
  }
  return {
    kind: SALES_KIND, version: 1, codecVersion: 1, capabilities: ['local'], consequential: false, dependencies: [],
    decodeInput: value => salesInput.parse(value),
    sourceKey: value => salesInput.parse(value).sourceId,
    decodeCheckpoint(version, value) {
      if (version !== 1) throw new Error('sales_checkpoint_incompatible')
      return value === null ? { after: 0, rows: 0, totalMinor: 0 } : salesCheckpoint.parse(value)
    },
    async validateRevision(job) {
      try { return await predicate(database, salesRevisionGuard(job)) } catch { return false }
    },
    async runUnit(claim, { database: db, limits, signal }) {
      if (signal.aborted) throw signal.reason
      const job = claim.job, { sourceId, sourceRevision, params } = scope(job)
      const checkpoint = salesCheckpoint.parse(job.checkpoint ?? { after: 0, rows: 0, totalMinor: 0 })
      const size = Math.min(100, limits.maxRowsPerUnit)
      const rows = await db.all<{ ordinal: number; sale_id: string; amount_minor: number; currency: string }>({ sql: `SELECT ordinal,sale_id,amount_minor,currency FROM reference_sales_rows
        WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND ordinal>? ORDER BY ordinal LIMIT ?`, params: [...params, checkpoint.after, size] })
      const after = rows.at(-1)?.ordinal ?? checkpoint.after
      const totalMinor = checkpoint.totalMinor + rows.reduce((total, row) => total + row.amount_minor, 0)
      if (!Number.isSafeInteger(totalMinor)) throw new Error('sales_total_out_of_range')
      const count = checkpoint.rows + rows.length
      const [revision] = await db.all<{ row_count: number; total_minor: number }>({ sql: `SELECT row_count,total_minor FROM reference_sales_revisions
        WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND state='ready'`, params })
      if (!revision) return { type: 'wait', reasonCode: 'sales_source_unavailable', recovery: 'Reconnect the exact requested source revision before resuming.' }
      const done = count === revision.row_count
      if (count > revision.row_count || (!done && rows.length === 0)) return { type: 'wait', reasonCode: 'sales_source_incomplete', recovery: 'Repair the exact source revision and reconcile its retained row count before resuming.' }
      const jobParams = [job.installationId, tenantKey(job.tenantId), job.id]
      const prepared = done && rows.length === 0 && (await db.all({ sql: 'SELECT 1 FROM reference_sales_results WHERE installation_id=? AND tenant_key=? AND job_id=?', params: jobParams })).length === 1
      const statements: Sql[] = rows.length ? [{ sql: `INSERT INTO reference_sales_published_rows(installation_id,tenant_key,job_id,source_id,revision,ordinal,sale_id,amount_minor,currency)
        SELECT installation_id,tenant_key,?,source_id,revision,ordinal,sale_id,amount_minor,currency FROM reference_sales_rows
        WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND ordinal>? AND ordinal<=? ORDER BY ordinal`,
        params: [job.id, ...params, checkpoint.after, after] }] : []
      if (done && !prepared) statements.push({ sql: `INSERT INTO reference_sales_results(installation_id,tenant_key,job_id,source_id,revision,row_count,total_minor,currency)
        SELECT ?,?,?,?,?,count(*),COALESCE(sum(amount_minor),0),'USD' FROM reference_sales_published_rows WHERE installation_id=? AND tenant_key=? AND job_id=?`,
        params: [...jobParams, sourceId, sourceRevision, ...jobParams] })
      // Exact page contents and cumulative totals prevent a moved cursor or
      // missing/extra domain row from committing as successful progress.
      const guards: Sql[] = [{ sql: `(SELECT count(*) FROM reference_sales_published_rows WHERE installation_id=? AND tenant_key=? AND job_id=?)=?
        AND (SELECT COALESCE(sum(amount_minor),0) FROM reference_sales_published_rows WHERE installation_id=? AND tenant_key=? AND job_id=?)=?
        AND (SELECT count(*) FROM reference_sales_rows WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND ordinal<=?)=?
        AND NOT EXISTS(SELECT 1 FROM reference_sales_published_rows p LEFT JOIN reference_sales_rows s
          ON s.installation_id=p.installation_id AND s.tenant_key=p.tenant_key AND s.source_id=p.source_id AND s.revision=p.revision AND s.ordinal=p.ordinal
          WHERE p.installation_id=? AND p.tenant_key=? AND p.job_id=? AND (s.ordinal IS NULL OR p.sale_id<>s.sale_id OR p.amount_minor<>s.amount_minor OR p.currency<>s.currency OR p.ordinal>?))`,
        params: [...jobParams, count, ...jobParams, totalMinor, ...params, after, count, ...jobParams, after] }]
      if (done) guards.push({ sql: `EXISTS(SELECT 1 FROM reference_sales_results WHERE installation_id=? AND tenant_key=? AND job_id=? AND row_count=? AND total_minor=?)
        AND EXISTS(SELECT 1 FROM reference_sales_revisions WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND state='ready' AND row_count=? AND total_minor=?)`,
        params: [...jobParams, count, totalMinor, ...params, count, totalMinor] })
      return { type: 'commit', unitKey: `sales:${job.checkpointSequence}`, expectedCheckpointSequence: job.checkpointSequence, statements, guards,
        checkpoint: rows.length ? { after, rows: count, totalMinor } : job.checkpoint,
        rows: rows.length, bytes: rows.length ? new TextEncoder().encode(JSON.stringify(rows)).byteLength : 0,
        // Publication follows preparation in a separate bounded unit, so the
        // verifier reads committed evidence even after a lost response/restart.
        ...(prepared ? { resultRef: { sourceId, sourceRevision, rows: count, totalMinor, currency: 'USD' } } : {}) }
    },
    async verifyResult(job, value) {
      const parsed = salesResult.safeParse(value)
      if (!parsed.success) return false
      const result = parsed.data, { sourceId, sourceRevision, params } = scope(job)
      if (result.sourceId !== sourceId || result.sourceRevision !== sourceRevision) return false
      return predicate(database, { sql: `EXISTS(SELECT 1 FROM reference_sales_results WHERE installation_id=? AND tenant_key=? AND job_id=?
        AND source_id=? AND revision=? AND row_count=? AND total_minor=? AND currency='USD')
        AND EXISTS(SELECT 1 FROM reference_sales_revisions WHERE installation_id=? AND tenant_key=? AND source_id=? AND revision=? AND state='ready' AND row_count=? AND total_minor=?)
        AND (SELECT count(*) FROM reference_sales_published_rows WHERE installation_id=? AND job_id=?)=?
        AND (SELECT COALESCE(sum(amount_minor),0) FROM reference_sales_published_rows WHERE installation_id=? AND job_id=?)=?`,
        params: [job.installationId, tenantKey(job.tenantId), job.id, sourceId, sourceRevision, result.rows, result.totalMinor,
          ...params, result.rows, result.totalMinor, job.installationId, job.id, result.rows, job.installationId, job.id, result.totalMinor] })
    },
  }
}
