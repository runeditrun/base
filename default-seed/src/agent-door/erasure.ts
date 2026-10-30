import { agentErasureStatements, type AgentArtifactMap } from '../../../modules/agent-door/index.ts'
import { createPortability } from '../../../modules/portability/index.mjs'
import { portabilityPolicy } from '../core/platform/portability-policy.mjs'

// The seed declares every table and column. ?1 holds native identifiers plus
// an optional sourceUserId selector, never caller SQL. Source IDs can be short:
// match whole tokens in text values, not substrings or numeric JSON metadata.
const sourceId = "CASE WHEN subject.type='object' THEN json_extract(subject.value,'$.sourceUserId') END"
const tokenCharacter = "'[A-Za-z0-9_@.+/:-]'"
// Check every literal occurrence, including one after an embedded occurrence.
// Keep URI/version separators inside tokens (for example policy/1 is not id 1).
const sourceMention = (column: string) => `EXISTS(
  WITH RECURSIVE hits(text,source,pos) AS (
    SELECT content.value,(${sourceId}),instr(content.value,(${sourceId}))
    FROM json_tree(CASE WHEN json_valid(${column}) THEN ${column} ELSE json_quote(${column}) END) content
    WHERE content.type='text'
    UNION ALL
    SELECT text,source,pos+instr(substr(text,pos+1),source) FROM hits
    WHERE pos>0 AND instr(substr(text,pos+1),source)>0
  )
  SELECT 1 FROM hits WHERE pos>0
    AND substr(text,pos-1,1) NOT GLOB ${tokenCharacter}
    AND substr(text,pos+length(source),1) NOT GLOB ${tokenCharacter}
)`
const mentions = (table: string, columns: string[]) => 'EXISTS(SELECT 1 FROM json_each(?1) subject WHERE ' + columns.map(name => {
  const column = table + '.' + name
  return "(subject.type='text' AND instr(CAST(" + column + " AS TEXT),CAST(subject.value AS TEXT))>0) OR (subject.type='object' AND (CAST(" + column + " AS TEXT)=(" + sourceId + ') OR ' + sourceMention(column) + '))'
}).join(' OR ') + ')'
const calls = mentions('agent_door_calls', ['key', 'outcome']), approvals = mentions('agent_door_approvals', ['saved', 'approvals', 'result']), reviews = mentions('agent_door_reviews', ['saved', 'marked_by']), audits = mentions('agent_door_audit', ['row', 'evidence'])
const decisions = "SELECT decision_id FROM agent_door_calls WHERE " + calls + " UNION SELECT json_extract(saved,'$.decision_id') FROM agent_door_approvals WHERE " + approvals + " UNION SELECT json_extract(saved,'$.decision_id') FROM agent_door_reviews WHERE " + reviews + " UNION SELECT id FROM agent_door_audit WHERE " + audits + " UNION SELECT json_extract(details,'$.operationId') FROM audit_events WHERE (entity_type='person' AND entity_id IN (SELECT value FROM json_each(?1))) OR (entity_type='note' AND entity_id IN (SELECT id FROM person_notes WHERE person_id IN (SELECT value FROM json_each(?1))))"
const match = (sql: string) => ({ sql, params: ['values'] })
export const personAgentArtifacts: AgentArtifactMap = { artifacts: [
  { table: 'agent_door_state', columns: ['id','envelope','local_document','local_revision','local_paused','decision_lock','decision_until'], unrelated: 'Installation policy and admission leases; customer subjects are not policy principals.' },
  { table: 'agent_door_agents', columns: ['id','name','specialist','sponsor','sponsor_name','revoked','window','requests','tombstone'], unrelated: 'Non-person agent identities and native operator sponsors; customer subjects are not operators.' },
  { table: 'agent_door_calls', columns: ['agent','key','digest','decision_id','created_at','state','outcome','expires_at'], match: match('decision_id IN (' + decisions + ')') },
  { table: 'agent_door_audit', columns: ['sequence','id','at','agent','classes','row','evidence'], match: match('id IN (' + decisions + ') OR json_extract(row,\'$.decision_id\') IN (' + decisions + ') OR json_extract(row,\'$.replay_of\') IN (' + decisions + ')') },
  { table: 'agent_door_approvals', columns: ['id','state','saved','approvals','result','version'], match: match('json_extract(saved,\'$.decision_id\') IN (' + decisions + ') OR ' + approvals) },
  { table: 'agent_door_reviews', columns: ['id','state','saved','marked_by','marked_at'], match: match('json_extract(saved,\'$.decision_id\') IN (' + decisions + ') OR ' + reviews) },
  { table: 'agent_door_events', columns: ['sequence','id','uri','event'], match: match(mentions('agent_door_events', ['uri','event']) + ' OR json_extract(event,\'$.decision_id\') IN (' + decisions + ')') },
  { table: 'agent_door_usage', columns: ['decision_id','at','seed','specialist','agent','classes'], match: match('decision_id IN (' + decisions + ')') },
  { table: 'agent_door_replay_aliases', columns: ['agent','alias','call_id','tombstone'], unrelated: 'Installation-private, value-free replay aliases; excluded from archives and exports.' },
] }

export async function erasePersonAgentArtifacts(db: D1Database, secret: string, subject: { id: string }, tombstone: { erasure_id: string; at: string }) {
  const person = await db.prepare('SELECT id,email,details FROM people WHERE id=?').bind(subject.id).first<{ id: string; email: string; details: string }>()
  if (!person) return []
  // Imported source IDs are exact identifiers too (the native import erasure
  // uses the same one). Never broaden selection to a shared name or free text.
  const sourceUserId = JSON.parse(person.details).sourceUserId
  const values = [person.id, person.email, ...(typeof sourceUserId === 'string' && sourceUserId.length ? [{ sourceUserId }] : [])]
  const portability = await createPortability({ db, buckets: {}, policy: { ...portabilityPolicy, buckets: {} } })
  return agentErasureStatements({ db, secret, map: personAgentArtifacts, subject: { values: JSON.stringify(values) }, tombstone,
    checkpoint: async () => await portability.redactionStatements() })
}
