import type { TallyScope } from './retirement-tally.ts';
import { sql } from './database.ts';

// Children precede parents so both the namespace/job links and foreign keys
// survive until the content they scope has been withdrawn.
const ORDER = ['ik_door_chunks', 'ik_door_plan_chunks', 'ik_door_approvals',
  'ik_door_uploads', 'ik_door_namespaces', 'ik_door_plans', 'ik_door_scopes'];

const namespaceLinks = (mapped: boolean, destination: boolean) => `SELECT p.installation_id,p.namespace FROM ik_door_plans p JOIN ik_jobs j
  ON j.id=p.job_id OR (p.job_id IS NULL AND j.operation_key='door:'||p.id) ${destination ? 'WHERE j.destination=?' : ''}
  ${mapped ? `UNION SELECT installation_id,namespace FROM ik_door_scopes ${destination ? 'WHERE destination=?' : ''}` : ''}`;

/** Withdraw a destination's opaque door bundles and snapshots whole. They may
 * contain rejected records or before-images that ordinary kit redaction cannot
 * safely rewrite. Old applied doors use their real job link, including the
 * operation key used to recover an interrupted job-index update. */
export function doorRetirementStore(name: string, installed: ReadonlySet<string>) {
  const withdraw = ORDER.indexOf(name);
  if (withdraw < 0) return undefined;
  const mapped = installed.has('ik_door_scopes');
  const namespaces = namespaceLinks(mapped, true);
  const inScope = `(installation_id,namespace) IN (${namespaces})`;
  const where = name === 'ik_door_chunks' ? `upload_id IN (SELECT id FROM ik_door_uploads WHERE ${inScope})`
    : name === 'ik_door_plan_chunks' || name === 'ik_door_approvals' ? `plan_id IN (SELECT id FROM ik_door_plans WHERE ${inScope})`
    : inScope;
  // A legacy, never-planned namespace cannot be assigned a destination by
  // guessing. Require its additive mapping rather than silently leaving bytes.
  const scopeGuard = name === 'ik_door_uploads' || name === 'ik_door_plans'
    ? sql(`NOT EXISTS(SELECT 1 FROM ${name} WHERE (installation_id,namespace) NOT IN (${namespaceLinks(mapped, false)}))`) : undefined;
  return { where, withdraw, scopeGuard, params: (scope: TallyScope) => mapped ? [scope.destination, scope.destination] : [scope.destination] };
}
