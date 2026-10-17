import type { ImportDoorOptions, DoorRequest } from './types.ts';
import { DoorError, verifyImportGrant, type DoorAction } from './grants.ts';
import { sql, transact } from './store.ts';

export async function enabled(options: ImportDoorOptions): Promise<boolean> {
  const row = await options.database.prepare('SELECT enabled FROM ik_door_settings WHERE installation_id=?').bind(options.claim.installationId).first();
  return row?.enabled === 1;
}
export async function admit(options: ImportDoorOptions, request: Request, action: DoorAction): Promise<DoorRequest> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new DoorError('grant_required', 401);
  const {grant, kid} = await verifyImportGrant(authorization.slice(7), options.claim);
  if (grant.action !== action || new URL(request.url).origin !== options.claim.appOrigin) throw new DoorError('grant_binding_mismatch');
  const basic = sql(`EXISTS(SELECT 1 FROM ik_door_settings WHERE installation_id=? AND enabled=1)
    AND NOT EXISTS(SELECT 1 FROM ik_door_revoked_keys WHERE installation_id=? AND kid=?)
    AND unixepoch() < ?`, grant.installationId, grant.installationId, kid, grant.exp);
  try {
    await transact(options.database, basic, [sql('INSERT INTO ik_door_grants(installation_id,jti,action,namespace,kid,expires) VALUES(?,?,?,?,?,?)', grant.installationId, grant.jti, action, grant.namespace, kid, grant.exp)]);
  } catch { throw new DoorError('grant_replayed_revoked_or_expired'); }
  const authority = sql(`(${basic.sql}) AND EXISTS(SELECT 1 FROM ik_door_grants WHERE installation_id=? AND jti=? AND action=? AND namespace=? AND kid=? AND expires=?)`, ...basic.params ?? [], grant.installationId, grant.jti, action, grant.namespace, kid, grant.exp);
  return {options, access: grant, authority, via:'grant'};
}
