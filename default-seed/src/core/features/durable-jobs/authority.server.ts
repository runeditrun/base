import type { Authority, Database } from '../../../../../modules/durable-jobs/src/types.ts'
import { SALES_NAMESPACE, tenantKey } from './codecs.server.ts'

/** Tenant selection is a lookup key, never authority. Membership and ownership
 * come from the installation DB and are checked again at every commit. */
export async function referenceSalesAuthority(database: Database, installationId: string, principalId: string, tenantId: string | null): Promise<Authority | null> {
  if (tenantId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(tenantId)) return null
  const [row] = await database.all<{ owner_id: string; role: string }>({ sql: `SELECT t.owner_id,p.role FROM reference_sales_tenants t
    JOIN reference_sales_memberships m ON m.installation_id=t.installation_id AND m.tenant_key=t.tenant_key
    JOIN oa_operators p ON p.id=m.principal_id AND p.status='active'
    JOIN oa_operators o ON o.id=t.owner_id AND o.status='active' AND o.role='owner'
    WHERE t.installation_id=? AND t.tenant_key=? AND t.active=1 AND m.principal_id=? AND m.active=1`,
    params: [installationId, tenantKey(tenantId), principalId] })
  return row ? { installationId, namespace: SALES_NAMESPACE, tenantId, principalId, ownerId: row.owner_id, operator: ['owner', 'admin'].includes(row.role) } : null
}

