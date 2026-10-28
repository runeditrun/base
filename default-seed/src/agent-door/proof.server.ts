import type { NativeProof } from '../../../modules/agent-door/index.ts'
import { STEP_UP_SECONDS } from '../../../modules/operator-auth/identity/email-link/index.mjs'

/** The sponsor's own email-link step-up, confirmed in a native session that
 * returned to this handoff, while it is still fresh. The door sees no credential. */
export const stepUpProof: NativeProof = {
  start: { action: '/auth/step-up', fields: { action: 'export' } },
  async verify(reference, ctx) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference)) return false
    const row = await ctx.db.prepare(`SELECT 1 AS fresh FROM oa_step_up_challenges c JOIN oa_operators o ON o.id=c.operator_id
      WHERE c.operator_id=? AND c.operator_version=o.version AND o.status='active' AND c.action='export' AND c.return_to=? AND c.consumed_at>=?`)
      .bind(ctx.person.id, `/agents/proofs/${ctx.kind}/${reference}`, Date.now() - STEP_UP_SECONDS * 1000).first()
    return !!row
  },
}
