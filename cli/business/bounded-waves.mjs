const PROTOCOL = 'rer-bounded-waves/1';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
/** Business supplies a typed arrangement and fresh grants. The sender cannot
 * choose a destination or manufacture any parent/child approval. */
export async function sendBoundedWaves({ arrangement, uploadId, fresh, request, signal, checkpoint = async () => {} }) {
 if (arrangement?.protocol !== PROTOCOL || !['migration','revision','policy'].every(k => id(arrangement[k]))) throw Error('BOUNDED_TASK_REQUIRED: Business must supply the typed bounded-wave arrangement.');
 const binding = { protocol: PROTOCOL, migration: arrangement.migration, revision: arrangement.revision, policy: arrangement.policy };
 const post = async (action, body, extra = {}) => {
  signal.throwIfAborted();
  const grant = await fresh(action, { bounded: { ...binding, ...extra } });
  return request(grant, body, signal);
 };
 let parentId = arrangement.parentId;
 if (parentId !== undefined && !id(parentId)) throw Error('Invalid bounded parent identifier.');
 // Replaying page zero resolves the durable preparation cursor, including a
 // response lost before Business saved the latest page checkpoint.
 {
  let ordinal = 0;
  for (;;) {
   const prepared = await post('prepare', { ...(parentId ? { parentId } : { uploadId, ...(arrangement.catchup ? { catchup: true } : {}) }), ordinal });
   if (!id(prepared.parentId) || !Number.isSafeInteger(prepared.next) || prepared.next <= ordinal) throw Error('Invalid bounded preparation response.');
   parentId = prepared.parentId; ordinal = prepared.next;
   await checkpoint({ parent_id: parentId, prepared_children: ordinal, aggregate_success: false });
   const status = await post('wave-status', { parentId });
   if (!Number.isSafeInteger(status.census?.children) || status.census.children < ordinal) throw Error('Invalid complete census response.');
   if (ordinal === status.census.children) break;
  }
 }
 if (!id(parentId)) throw Error('Invalid bounded parent identifier.');
 const sealed = await post('seal-parent', { parentId });
 if (!digest(sealed.fingerprint) || sealed.parentId !== parentId || !Array.isArray(sealed.children)) throw Error('Invalid sealed parent response.');
 const approval = arrangement.parentApproval;
 if (!approval) return { parentId, fingerprint: sealed.fingerprint, state: 'awaiting_parent_approval', aggregateSuccess: false, children: sealed.children };
 if (approval.fingerprint !== sealed.fingerprint || !Array.isArray(arrangement.children) || arrangement.children.length !== sealed.children.length
  || arrangement.children.some((c, i) => c.ordinal !== i || c.fingerprint !== sealed.children[i].fingerprint)) throw Error('Business approvals differ from the immutable server children.');
 const parentBinding = { parentFingerprint: approval.fingerprint, parentApprovalRecordId: approval.id, parentApprovedAt: approval.at };
 await post('review-parent', { parentId }, parentBinding);
 for (const child of arrangement.children) {
  // Approvals are request/grant inputs to Business, never proof from this task.
  if (!child.approval) return { parentId, state: 'awaiting_child_approval', ordinal: child.ordinal, aggregateSuccess: false };
  for (;;) {
   const status = await post('wave-status', { parentId });
   if (status.state === 'withdrawn') throw Error('Bounded parent was withdrawn.');
   const current = status.children?.[child.ordinal];
   if (!current || current.fingerprint !== child.fingerprint) throw Error('Server child inventory changed.');
   if (current.childSuccess) break;
   const applied = await post('apply-child', { parentId, ordinal: child.ordinal, reviewedFingerprint: child.fingerprint }, { ...parentBinding, childFingerprint: child.fingerprint });
   await checkpoint({ parent_id: parentId, child: child.ordinal, job_id: applied.job?.id, child_success: applied.childSuccess === true, aggregate_success: false });
   if (!applied.job || ['failed','undone','rolled_back'].includes(applied.job.state)) return { parentId, state: 'partial', ordinal: child.ordinal, aggregateSuccess: false };
  }
 }
 const aggregate = await post('finalize-parent', { parentId }, parentBinding);
 if (aggregate.parentId !== parentId || aggregate.fingerprint !== sealed.fingerprint || aggregate.aggregateSuccess !== true || aggregate.completeHead !== parentId) throw Error('Destination did not return a complete aggregate receipt.');
 await checkpoint({ parent_id: parentId, aggregate_success: true });
 return aggregate;
}
