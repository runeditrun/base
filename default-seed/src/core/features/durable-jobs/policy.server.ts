import type { Action, Authority, Database, Job, Policy, Sql } from '../../../../../modules/durable-jobs/src/types.ts'
import { SALES_NAMESPACE, salesInput, salesRevision, tenantKey } from './codecs.server.ts'

export function salesAuthorityGuard(job: Pick<Job, 'installationId' | 'tenantId' | 'ownerId' | 'principalId'>): Sql {
  return { sql: `EXISTS(SELECT 1 FROM reference_sales_tenants t
    JOIN reference_sales_memberships m ON m.installation_id=t.installation_id AND m.tenant_key=t.tenant_key
    JOIN oa_operators p ON p.id=m.principal_id AND p.status='active'
    JOIN oa_operators o ON o.id=t.owner_id AND o.status='active' AND o.role='owner'
    WHERE t.installation_id=? AND t.tenant_key=? AND t.owner_id=? AND t.active=1 AND m.principal_id=? AND m.active=1)`,
    params: [job.installationId, tenantKey(job.tenantId), job.ownerId, job.principalId] }
}

export function salesRevisionGuard(job: Job): Sql {
  const input = salesInput.parse(job.inputRef), revision = salesRevision.parse(job.requestedRevision)
  return { sql: `EXISTS(SELECT 1 FROM reference_sales_sources s JOIN reference_sales_revisions r
    ON r.installation_id=s.installation_id AND r.tenant_key=s.tenant_key AND r.source_id=s.source_id AND r.revision=s.current_revision
    WHERE s.installation_id=? AND s.tenant_key=? AND s.source_id=? AND s.current_revision=? AND s.active=1 AND r.state='ready')`,
    params: [job.installationId, tenantKey(job.tenantId), input.sourceId, revision.sourceRevision] }
}

export async function predicate(database: Database, guard: Sql) {
  return (await database.all({ sql: `SELECT 1 AS allowed WHERE (${guard.sql})`, params: guard.params })).length === 1
}

export function createSalesPolicy(database: Database, installationId: string): Policy {
  const incoming = (action: Action, job: Job, authority?: Authority) => {
    if (!authority) return ['claim', 'commit', 'publish'].includes(action)
    return authority.installationId === installationId && authority.namespace === SALES_NAMESPACE
      && authority.tenantId === job.tenantId && authority.ownerId === job.ownerId
      && (authority.principalId === job.principalId || authority.operator === true)
  }
  const guards = (action: Action, job: Job, authority?: Authority): Sql[] => [salesAuthorityGuard(job),
    ...(['create', 'claim', 'commit', 'publish', 'resume'].includes(action) ? [salesRevisionGuard(job)] : []),
    ...(authority && authority.principalId !== job.principalId ? [{ sql: `EXISTS(SELECT 1 FROM oa_operators o
      JOIN reference_sales_memberships m ON m.principal_id=o.id WHERE o.id=? AND o.status='active' AND o.role IN ('owner','admin')
      AND m.installation_id=? AND m.tenant_key=? AND m.active=1)`, params: [authority.principalId, installationId, tenantKey(job.tenantId)] }] : [])]
  return {
    async authorizeScope(authority) {
      return authority.installationId === installationId && authority.namespace === SALES_NAMESPACE
        && await predicate(database, salesAuthorityGuard(authority))
    },
    async resultAvailable(job) {
      try {
        const input = salesInput.parse(job.inputRef), revision = salesRevision.parse(job.requestedRevision)
        return await predicate(database, { sql: `EXISTS(SELECT 1 FROM reference_sales_sources s
          JOIN reference_sales_revisions r ON r.installation_id=s.installation_id AND r.tenant_key=s.tenant_key AND r.source_id=s.source_id
          JOIN reference_sales_results p ON p.installation_id=r.installation_id AND p.tenant_key=r.tenant_key AND p.source_id=r.source_id AND p.revision=r.revision
          WHERE s.installation_id=? AND s.tenant_key=? AND s.source_id=? AND s.active=1 AND r.revision=? AND r.state='ready' AND p.job_id=?)`,
          params: [job.installationId, tenantKey(job.tenantId), input.sourceId, revision.sourceRevision, job.id] })
      } catch { return false }
    },
    async authorize(action, job, authority) {
      if (job.installationId !== installationId || job.namespace !== SALES_NAMESPACE || !incoming(action, job, authority)) return false
      try {
        for (const guard of guards(action, job, authority)) if (!await predicate(database, guard)) return false
        return true
      } catch { return false }
    },
    commitGuards(action, job, authority) {
      if (!incoming(action, job, authority)) return [{ sql: '0' }]
      return guards(action, job, authority)
    },
  }
}
