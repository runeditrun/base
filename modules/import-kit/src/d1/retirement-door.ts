import type { D1Database } from './types.ts';
import type { Store, TallyScope } from './retirement-tally.ts';

// Record content only, children before parents. Plans, approvals, namespaces
// and scopes are bookkeeping (see retirement-tally.ts) and keep import history.
const ORDER = ['ik_door_chunks', 'ik_door_plan_chunks', 'ik_door_uploads'];

// Namespaces linked to a destination: its first-upload binding, or a plan
// applied by a kit job (old applied doors use their real job link, including
// the operation key used to recover an interrupted job-index update).
const linked = (mapped: boolean, destination: boolean) => `SELECT p.installation_id,p.namespace FROM ik_door_plans p JOIN ik_jobs j
  ON j.id=p.job_id OR (p.job_id IS NULL AND j.operation_key='door:'||p.id) ${destination ? 'WHERE j.destination=?' : ''}
  ${mapped ? `UNION SELECT installation_id,namespace FROM ik_door_scopes ${destination ? 'WHERE destination=?' : ''}` : ''}`;

/** A namespace is in scope when it is linked to the erased destination, or when
 * it is linked to none: previous door code wrote uploads and plans without a
 * binding, and no destination ever applied them, so any erasure withdraws them. */
function inScope(mapped: boolean) {
  return `((installation_id,namespace) IN (${linked(mapped, true)}) OR (installation_id,namespace) NOT IN (${linked(mapped, false)}))`;
}

function where(name: string, mapped: boolean) {
  const scoped = inScope(mapped);
  return name === 'ik_door_chunks' ? `upload_id IN (SELECT id FROM ik_door_uploads WHERE ${scoped})`
    : name === 'ik_door_plan_chunks' ? `plan_id IN (SELECT id FROM ik_door_plans WHERE ${scoped})`
    : scoped;
}

const params = (mapped: boolean) => (scope: TallyScope) => mapped ? [scope.destination, scope.destination] : [scope.destination];

/** Withdraw a destination's opaque door bundles and snapshot bodies whole. They
 * may contain rejected records or before-images that ordinary kit redaction
 * cannot safely rewrite. `installed` lists every ik_ table in the database. */
export function doorRetirementStore(name: string, installed: ReadonlySet<string>) {
  const withdraw = ORDER.indexOf(name);
  if (withdraw < 0) return undefined;
  const mapped = installed.has('ik_door_scopes');
  return { where: where(name, mapped), withdraw, params: params(mapped) };
}

/** Whether an erasure of this destination withdraws door content, which makes
 * it fenced: it then requires and commits the restore checkpoint. One read,
 * and none where the door is not installed. */
export async function doorCustodyInScope(db: D1Database, destination: string, stores: readonly Store[]): Promise<boolean> {
  const door = stores.filter(store => store.withdraw !== undefined);
  if (!door.length) return false;
  const scope = { destination, jobs: [], streams: [] };
  const row = await db.prepare(`SELECT ${door.map(store => `EXISTS(SELECT 1 FROM ${store.name} WHERE ${store.where})`).join(' OR ')} AS found`)
    .bind(...door.flatMap(store => store.params(scope))).first<{ found: number }>();
  return row?.found === 1;
}
