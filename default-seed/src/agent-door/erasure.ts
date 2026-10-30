import { agentErasureStatements, type AgentArtifactMap } from '../../../modules/agent-door/index.ts'
import { createPortability } from '../../../modules/portability/index.mjs'
import { portabilityPolicy } from '../core/platform/portability-policy.mjs'

// The seed declares every table and column. ?1 is a JSON array of the native
// erasure's exact subject identifiers and personal values, never caller SQL.
const mentions = (columns: string[]) => 'EXISTS(SELECT 1 FROM json_each(?1) subject WHERE ' + columns.map(column => "instr(CAST(" + column + " AS TEXT),CAST(subject.value AS TEXT))>0").join(' OR ') + ')'
const calls = mentions(['outcome']), approvals = mentions(['saved', 'approvals', 'result']), reviews = mentions(['saved', 'marked_by']), audits = mentions(['row', 'evidence'])
const decisions = "SELECT decision_id FROM agent_door_calls WHERE " + calls + " UNION SELECT json_extract(saved,'$.decision_id') FROM agent_door_approvals WHERE " + approvals + " UNION SELECT json_extract(saved,'$.decision_id') FROM agent_door_reviews WHERE " + reviews + " UNION SELECT id FROM agent_door_audit WHERE " + audits + " UNION SELECT json_extract(details,'$.operationId') FROM audit_events WHERE (entity_type='person' AND entity_id IN (SELECT value FROM json_each(?1))) OR (entity_type='note' AND entity_id IN (SELECT id FROM person_notes WHERE person_id IN (SELECT value FROM json_each(?1))))"
const match = (sql: string) => ({ sql, params: ['values'] })
export const personAgentArtifacts: AgentArtifactMap = { artifacts: [
  { table: 'agent_door_state', columns: ['id','envelope','local_document','local_revision','local_paused','decision_lock','decision_until'], unrelated: 'Installation policy and admission leases; customer subjects are not policy principals.' },
  { table: 'agent_door_agents', columns: ['id','name','specialist','sponsor','sponsor_name','revoked','window','requests','tombstone'], unrelated: 'Non-person agent identities and native operator sponsors; customer subjects are not operators.' },
  { table: 'agent_door_calls', columns: ['agent','key','digest','decision_id','created_at','state','outcome'], match: match('decision_id IN (' + decisions + ')') },
  { table: 'agent_door_audit', columns: ['sequence','id','at','agent','classes','row','evidence'], match: match('id IN (' + decisions + ') OR json_extract(row,\'$.decision_id\') IN (' + decisions + ')') },
  { table: 'agent_door_approvals', columns: ['id','state','saved','approvals','result','version'], match: match('json_extract(saved,\'$.decision_id\') IN (' + decisions + ') OR ' + approvals) },
  { table: 'agent_door_reviews', columns: ['id','state','saved','marked_by','marked_at'], match: match('json_extract(saved,\'$.decision_id\') IN (' + decisions + ') OR ' + reviews) },
  { table: 'agent_door_events', columns: ['sequence','id','uri','event'], match: match(mentions(['uri','event']) + ' OR json_extract(event,\'$.decision_id\') IN (' + decisions + ')') },
  { table: 'agent_door_usage', columns: ['decision_id','at','seed','specialist','agent','classes'], match: match('decision_id IN (' + decisions + ')') },
  { table: 'agent_door_replay_aliases', columns: ['agent','alias','call_id','tombstone'], unrelated: 'Installation-private, value-free replay aliases; excluded from archives and exports.' },
] }

export async function erasePersonAgentArtifacts(db: D1Database, secret: string, subject: { id: string }, tombstone: { erasure_id: string; at: string }) {
  const person = await db.prepare('SELECT id,email FROM people WHERE id=?').bind(subject.id).first<{ id: string; email: string }>()
  if (!person) return []
  const portability = await createPortability({ db, buckets: {}, policy: { ...portabilityPolicy, buckets: {} } })
  return agentErasureStatements({ db, secret, map: personAgentArtifacts, subject: { values: JSON.stringify(Object.values(person)) }, tombstone,
    checkpoint: async () => await portability.redactionStatements() })
}
