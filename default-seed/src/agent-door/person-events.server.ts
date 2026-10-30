import type { Bindings } from '../core/platform/bindings.server'
import type { Operator } from '../../../modules/operator-auth/index.mjs'

/** The person's native action has committed. Publish the same resource URI the
 * agent tools use, with person attribution, through the shared event log. */
export async function personRecordEvent(bindings: Bindings, operator: Operator, type: string, id: string) {
  const { baseAgentDoor } = await import('./index.server')
  // This notification can run after the redaction hook, including when a
  // queued erasure finishes before the original request returns. Its event
  // type and timestamp suffice; never append the subject identifier again.
  const erasure = type === 'person.erasure.requested'
  await baseAgentDoor(bindings).emit({ type, uri: erasure ? 'base://erasures' : `base://person/${encodeURIComponent(id)}`, person: {
    id: operator.id, name: operator.displayName, email: operator.email, role: operator.role, active: operator.status === 'active',
  }, data: erasure ? {} : { id } })
}
