import { createAgentDoor, operatorAuthPeople, type Trust } from '../../../modules/agent-door/index.ts'
import type { Bindings } from '../core/platform/bindings.server'
import { authConfig } from '../core/platform/auth/config.server'
import { operatorAuth } from '../core/platform/auth/session.server'
import { accessTools, operatorResource } from './access-tools'
import { peopleTools, personResource } from './people-tools'

function trust(bindings: Bindings): Trust | null {
  const issuer = bindings.RER_OWNER_CLAIM_ISSUER, installationId = bindings.RER_OWNER_CLAIM_INSTALLATION_ID
  const appOrigin = bindings.RER_OWNER_CLAIM_APP_ORIGIN ?? bindings.AUTH_ORIGIN, publicKeys = bindings.RER_OWNER_CLAIM_PUBLIC_KEYS
  if (![issuer, installationId, bindings.RER_OWNER_CLAIM_APP_ORIGIN, publicKeys].some(Boolean)) return null
  if (!issuer || !installationId || !appOrigin || !publicKeys) throw new Error('Incomplete agent door trust configuration')
  return { issuer, installationId, appOrigin, publicKeys: JSON.parse(publicKeys) as Trust['publicKeys'] }
}

export function baseAgentDoor(bindings: Bindings) {
  return createAgentDoor({
    seed: 'base', name: 'Base', specialist: 'operations', db: bindings.DB, origin: bindings.AUTH_ORIGIN, trust: trust(bindings),
    erasure: { secret: bindings.SESSION_SECRET, async fenced(name, args) {
      if (name === 'base.people.erase') return false
      if (typeof args.id === 'string' && name.startsWith('base.people.')) {
        return !!await bindings.DB.prepare("SELECT 1 FROM person_erasure_redactions WHERE person_id=? UNION ALL SELECT 1 FROM rer_erasure_operations WHERE entity='person' AND phase='deleting' AND json_extract(subject,'$.id')=?").bind(args.id, args.id).first()
      }
      return false
    } },
    people: operatorAuthPeople({ db: bindings.DB, allowList: authConfig(bindings).allowList, session: request => operatorAuth(bindings).getSession(request) }),
    tools: [...peopleTools(bindings), ...accessTools(bindings)], resources: [personResource, operatorResource(bindings)],
    notTools: [
      { clauses: ['BASE-AGENT-003'], reason: 'import-door' },
      { clauses: ['BASE-AGENT-003'], reason: 'installation' },
    ],
  })
}
