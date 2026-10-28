import type { ClassAndFacts, Principal, Runtime, PolicyState } from './types.ts'

// Serialize only policy admission, never a native action or external request.
// A lost admission lease cannot commit a usage reservation. Reservations are
// visible before execution, so concurrent calls cannot both consume a cap.
export async function acquireDecision(rt: Runtime, id: string): Promise<boolean> {
  const result = await rt.options.db.prepare('UPDATE agent_door_state SET decision_lock=?,decision_until=? WHERE id=1 AND (decision_lock IS NULL OR decision_until<=?)')
    .bind(id, rt.now() + 30000, rt.now()).run()
  return !!result.meta.changes
}
export async function releaseDecision(rt: Runtime, id: string) {
  await rt.options.db.prepare('UPDATE agent_door_state SET decision_lock=NULL,decision_until=NULL WHERE id=1 AND decision_lock=?').bind(id).run()
}
export async function reserveUsage(rt: Runtime, id: string, principal: Principal, classes: ClassAndFacts[], state: PolicyState): Promise<boolean> {
  const result = await rt.options.db.prepare(`INSERT INTO agent_door_usage(decision_id,at,seed,specialist,agent,classes)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM agent_door_state WHERE id=1 AND decision_lock=? AND decision_until>? AND local_paused=0 AND ${rt.options.trust ? "json_extract(envelope,'$.revision') IS ? AND json_extract(envelope,'$.paused')=0 AND json_extract(envelope,'$.exp')*1000>?" : 'local_revision IS ?'})`)
    .bind(id, rt.now(), rt.options.seed, principal.agent.specialist ?? null, principal.agent.id, JSON.stringify(classes), id, rt.now(), state.revision, ...(rt.options.trust ? [rt.now()] : [])).run()
  return !!result.meta.changes
}
export async function removeUsage(rt: Runtime, id: string) {
  await rt.options.db.prepare('DELETE FROM agent_door_usage WHERE decision_id=?').bind(id).run()
}
