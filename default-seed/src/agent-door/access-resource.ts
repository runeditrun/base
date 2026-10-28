import type { ResourceDefinition } from '../../../modules/agent-door/index.ts'
import { readOperator, requirePeopleAccess } from './repository.server'

/** Access events use the same current native permission and record lookup. */
export const operatorResource: ResourceDefinition = {
  uriTemplate: 'base://operator/{id}', name: 'Operator access',
  description: 'Current native operator role and invitation status.',
  mimeType: 'application/json', scope: 'access:write', classes: ['standard'],
  classify: () => [{ class: 'standard', facts: { measure: 1 } }],
  async read(uri, ctx) {
    requirePeopleAccess(ctx.person)
    const match = /^base:\/\/operator\/([^/?#]+)$/.exec(uri)
    if (!match) return null
    const operator = await readOperator(ctx.db, decodeURIComponent(match[1]))
    return operator ? { json: { id: operator.id, role: operator.role, status: operator.status, version: operator.version } } : null
  },
}
