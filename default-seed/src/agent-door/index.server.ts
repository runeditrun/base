import { createAgentDoor, operatorAuthPeople, type Trust } from '../../../modules/agent-door/index.ts'
import type { Bindings } from '../core/platform/bindings.server'
import { authConfig } from '../core/platform/auth/config.server'
import { operatorAuth } from '../core/platform/auth/session.server'
import { accessTools } from './access-tools'
import { peopleTools, personResource } from './people-tools'
import { stepUpProof } from './proof.server'

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
    people: operatorAuthPeople({ db: bindings.DB, allowList: authConfig(bindings).allowList, session: request => operatorAuth(bindings).getSession(request) }),
    tools: [...peopleTools(bindings), ...accessTools(bindings)], resources: [personResource], nativeProof: { step_up: stepUpProof },
    notTools: [
      { clauses: ['BASE-AGENT-003'], reason: 'import-door' },
      { clauses: ['BASE-AGENT-003'], reason: 'installation' },
    ],
  })
}
