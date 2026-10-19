import type { ScheduledPolicy } from '../../../../../modules/operator-auth/index.mjs'

// Trusted declaration. Editing kind, parameters or scopes changes the hash.
export const policyDefinitions = (): ScheduledPolicy[] => [{
  id: 'inactive-members',
  kind: 'deactivate-members-without-recent-signin.v1',
  parameters: { inactiveDays: 90 },
  actions: [{ action: 'operators:deactivate', scope: { roles: ['member'], inactiveDays: 90 } }],
}]

