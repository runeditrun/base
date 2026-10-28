import type { Bindings } from '../core/platform/bindings.server'
import type { Operator } from '../../../modules/operator-auth/index.mjs'

/** The person's native action has committed. Publish the same resource URI the
 * agent tools use, with person attribution, through the shared event log. */
export async function personRecordEvent(bindings: Bindings, operator: Operator, type: string, id: string) {
  const { baseAgentDoor } = await import('./index.server')
  await baseAgentDoor(bindings).emit({ type, uri: `base://person/${encodeURIComponent(id)}`, person: {
    id: operator.id, name: operator.displayName, email: operator.email, role: operator.role, active: operator.status === 'active',
  }, data: { id } })
}
