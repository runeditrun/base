import { AuthError } from '../../../../../modules/operator-auth/index.mjs'
import { policyDefinitions } from './definitions.server'
import type { Bindings } from '../../platform/bindings.server'
import { operatorAuth } from '../../platform/auth/session.server'

export async function runScheduledPolicies(bindings: Bindings) {
  const door = operatorAuth(bindings).scheduledPolicies!
  const failures: unknown[] = []
  // Selection can be overbroad: each mutation repeats the approved scope in SQL.
  for (const policy of policyDefinitions()) {
    try {
      await door.run(policy.id, async run => {
        const days = policy.actions[0].scope.inactiveDays!
        const cutoff = Date.now() - days * 86400000
        const candidates = (await bindings.DB.prepare(`SELECT id FROM oa_operators WHERE role='member' AND status='active'
          AND created_at<=? AND COALESCE(last_signin_at,created_at)<=?
          ORDER BY created_at,id LIMIT ?`).bind(cutoff, cutoff, policy.maxActionsPerRun).all<{ id: string }>()).results
        for (const candidate of candidates) await run.execute('operators:deactivate', candidate.id)
      })
    } catch (error) {
      // Refusals are durable and visible to the owner. Other cron maintenance
      // still runs when this optional example awaits approval or is revoked.
      if (!(error instanceof AuthError)) failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Scheduled policies failed')
}
