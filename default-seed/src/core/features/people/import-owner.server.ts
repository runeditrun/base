import type { D1Sql } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'

// A permanent product-owned key. A later claim installation id does not move
// earlier settings, history or lineage into a different door.
export const PEOPLE_DOOR_KEY = 'base:people'
export const PEOPLE_PRINCIPAL = 'role:owner'

/** Authentication is checked normally at admission and again inside each D1
 * transaction, including the exact session, operator version and OIDC policy. */
export async function importOwnerPredicate(request: Request, env: Bindings): Promise<D1Sql | null> {
  if (new URL(request.url).origin !== env.AUTH_ORIGIN
    || (request.headers.has('Host') && request.headers.get('Host')?.toLowerCase() !== new URL(env.AUTH_ORIGIN).host.toLowerCase())
    || request.headers.get('sec-fetch-site') === 'cross-site'
    || (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') !== env.AUTH_ORIGIN)) return null
  const session = await sessionForRequest(env, request)
  if (!session || session.operator.role !== 'owner') return null
  return {
    sql: `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
      WHERE s.id=? AND s.operator_id=? AND s.revoked_at IS NULL
      AND s.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND s.operator_version=o.version AND o.version=? AND o.status='active' AND o.role='owner' AND o.email=?
      AND (s.kind!='oidc' OR EXISTS(SELECT 1 FROM oa_provider_sessions p JOIN oa_auth_settings a
        ON a.singleton=1 AND a.idp_sign_in=1 AND a.generation=p.generation WHERE p.session_id=s.id))
      AND NOT EXISTS(SELECT 1 FROM oa_provider_session_pins p WHERE p.session_id=s.id
        AND NOT EXISTS(SELECT 1 FROM oa_identity_providers i WHERE i.provider_id=p.provider_id
          AND i.status='linked' AND i.issuer=p.issuer AND i.client_id=p.client_id AND i.linked_at=p.linked_at)))`,
    params: [session.id, session.operator.id, session.operator.version, session.operator.email],
  }
}

