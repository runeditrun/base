import type { NativeTarget } from './types.ts'

// Whitelist attribution IDs rather than removing known body fields: future
// result extensions and seed-supplied facts/text must not survive the fence.
const refused = (value: string) => `json_object(
  'outcome','refused','code','target_erased','decision',NULL,
  'decision_id',coalesce(json_extract(${value},'$.decision_id'),json_extract(${value},'$.decision.id')),
  'execution_id',json_extract(${value},'$.execution_id'),
  'receipt',json_object('id',json_extract(${value},'$.receipt.id'),
    'decision_id',json_extract(${value},'$.receipt.decision_id'),
    'approval_id',json_extract(${value},'$.receipt.approval_id')),
  'approval',json_object('id',json_extract(${value},'$.approval.id')))`

const resourceMatch = (value: string) => `EXISTS (
  SELECT 1 FROM json_each(json_extract(${value},'$.resources')) resource
  JOIN json_each((SELECT uris FROM erased)) uri
    ON json_extract(resource.value,'$.uri')=uri.value)`

const targetMatch = (decision: string) => `EXISTS (
  SELECT 1 FROM agent_door_audit audit
  JOIN json_each((SELECT targets FROM erased)) target
    ON json_extract(audit.row,'$.resource.kind')=json_extract(target.value,'$.kind')
   AND json_extract(audit.row,'$.resource.id')=json_extract(target.value,'$.id')
  WHERE audit.id=${decision} OR json_extract(audit.row,'$.decision_id')=${decision})`

/** Add these statements to the SAME D1 batch as the native erasure. Targets
 * must use the seed's audit-safe target mapping; URIs must be exact result
 * resource URIs. No subject identity or new table is retained by this seam.
 * This fences retained replay, not every custody store or concurrent execution.
 */
export function erasureFenceStatements(db: D1Database, { targets = [], uris = [] }: { targets?: NativeTarget[]; uris?: string[] }): D1PreparedStatement[] {
  if (targets.some(target => !target || ![target.kind, target.id].every(value => typeof value === 'string' && value.trim().length)) || uris.some(uri => typeof uri !== 'string' || !uri.trim())) throw new TypeError('Invalid erasure fence subject')
  if (!targets.length && !uris.length) return []
  const input = [JSON.stringify(targets), JSON.stringify(uris)]
  const erased = 'WITH erased AS (SELECT ? AS targets, ? AS uris)'
  // Calls are rewritten first, while completed approval results still carry
  // their resource mapping. The approval update can then follow the call's
  // tombstone even when only the call outcome held the subject URI.
  return [
    db.prepare(`${erased}
      UPDATE agent_door_calls AS call SET state='refused',outcome=${refused('call.outcome')}
      WHERE ${targetMatch('call.decision_id')} OR ${resourceMatch('call.outcome')}
        OR EXISTS (SELECT 1 FROM agent_door_approvals approval
          WHERE json_extract(approval.saved,'$.decision_id')=call.decision_id
            AND (${resourceMatch('approval.result')} OR ${resourceMatch("json_extract(approval.saved,'$.result')")}))`).bind(...input),
    db.prepare(`${erased}
      UPDATE agent_door_approvals AS approval SET result=${refused('approval.result')},
        saved=json_set(approval.saved,'$.args',json('{}'),'$.summary',json('{}'),
          '$.result',${refused("json_extract(approval.saved,'$.result')")}),
        state='refused',version=version+1
      WHERE ${targetMatch("json_extract(approval.saved,'$.decision_id')")}
        OR ${resourceMatch('approval.result')} OR ${resourceMatch("json_extract(approval.saved,'$.result')")}
        OR EXISTS (SELECT 1 FROM agent_door_calls call
          WHERE call.decision_id=json_extract(approval.saved,'$.decision_id')
            AND json_extract(call.outcome,'$.code')='target_erased')`).bind(...input),
  ]
}
