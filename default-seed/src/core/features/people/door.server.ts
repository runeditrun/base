import { createImportDoorHandler } from '../../../../../modules/import-kit/src/door/index.ts'
import { createImportOperatorHandler } from '../../../../../modules/import-kit/src/door/operator.ts'
import type { D1Database as KitDatabase } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { Bindings } from '../../platform/bindings.server'
import { sessionForRequest } from '../../platform/auth/session.server'
import { peopleMapping, parsePeople, personTargets } from './imports.server'
import { importOwnerPredicate, PEOPLE_DOOR_KEY, PEOPLE_PRINCIPAL } from './import-owner.server'
import { importOwnerResponse, initializeImportSettings } from './import-settings.server'

const refused = (error: string, status: number) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

/** The same allow-list serves the owner's screen and signed Business grants. */
export function importSource(name: string) {
  return name === 'people' ? { parse: parsePeople, mapping: peopleMapping } : null
}

/** Runs before dispatch's host and body-size boundaries. The kit owns admission
 * and the bounded chunk transport for both authorities. */
export async function importDoorResponse(request: Request, env: Bindings): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/api/operator/import') && !path.startsWith('/api/rer/import/')) return null
  const runtime = {
    database: env.DB as unknown as KitDatabase, targets: personTargets,
    ownerPrincipalId: PEOPLE_PRINCIPAL, destination: 'people', format: 'json' as const,
  }
  if (path.startsWith('/api/rer/import/')) {
    if (!env.RER_OWNER_CLAIM_PUBLIC_KEYS) return refused('not_found', 404)
    return createImportDoorHandler({ ...runtime, source: importSource, installationId: PEOPLE_DOOR_KEY,
      claim: { issuer: env.RER_OWNER_CLAIM_ISSUER ?? '', installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID ?? '',
        appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) },
    })(request)
  }
  const ownerAction = await importOwnerResponse(request, env)
  if (ownerAction) return ownerAction
  if (!path.startsWith('/api/operator/import/')) return null
  const source = importSource(request.headers.get('X-Import-Source') ?? 'people')
  if (!source) return refused('unknown_import_source', 400)
  if (new URL(request.url).origin !== env.AUTH_ORIGIN || request.headers.get('Origin') !== env.AUTH_ORIGIN
    || (request.headers.has('Host') && request.headers.get('Host')?.toLowerCase() !== new URL(env.AUTH_ORIGIN).host.toLowerCase())
    || request.headers.get('sec-fetch-site') === 'cross-site') return refused('origin_required', 403)
  const session = await sessionForRequest(env, request)
  if (!session || session.operator.role !== 'owner') return refused('owner_required', 401)
  return createImportOperatorHandler({ ...runtime, ...source, installationId: PEOPLE_DOOR_KEY,
    appOrigin: env.AUTH_ORIGIN, ownerEmail: session.operator.email, namespace: 'people',
    authorize: async (request) => {
      const owner = await importOwnerPredicate(request, env)
      if (owner) await initializeImportSettings(runtime.database, owner)
      return owner
    },
  })(request)
}
