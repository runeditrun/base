// Identity, not a property of a request or session, selects this fence.
const actors = new WeakMap();
export function bindPolicyActor(actor, fence) { actors.set(actor, fence); }
export function policyActorFence(actor) { return actors.get(actor)?.(); }
export function approvalFence(approval) {
  return { sql: `EXISTS(SELECT 1 FROM oa_policy_approvals pa JOIN oa_operators po ON po.id=pa.owner_id
    WHERE pa.id=? AND pa.policy_id=? AND pa.version_hash=? AND pa.actions=? AND pa.revoked_at IS NULL
    AND po.status='active' AND po.role='owner' AND po.version=pa.owner_version)`,
  args: [approval.id, approval.policyId, approval.versionHash, approval.actions] };
}
export function actionFence(approval, runId, action, target, now) {
  const approvalGuard = approvalFence(approval);
  const scopes = JSON.parse(approval.actions).filter(grant => grant.action === action).map(({ scope }) => {
    const args = [...scope.roles];
    let sql = `role IN (${scope.roles.map(() => '?').join(',')})`;
    if (scope.operatorIds) { sql += ` AND id IN (${scope.operatorIds.map(() => '?').join(',')})`; args.push(...scope.operatorIds); }
    if (scope.inactiveDays !== undefined) {
      sql += ' AND created_at<=? AND NOT EXISTS(SELECT 1 FROM oa_sessions recent WHERE recent.operator_id=oa_operators.id AND recent.created_at>?)';
      const cutoff = now - scope.inactiveDays * 86400000; args.push(cutoff, cutoff);
    }
    return { sql: '(' + sql + ')', args };
  });
  return { sql: `${approvalGuard.sql} AND EXISTS(SELECT 1 FROM oa_policy_runs WHERE id=? AND approval_id=? AND status='running')
    AND role!='owner' AND status!='invited' AND id=? AND (${scopes.map(scope => scope.sql).join(' OR ') || '0'})`,
  args: [...approvalGuard.args, runId, approval.id, target.id, ...scopes.flatMap(scope => scope.args)] };
}
