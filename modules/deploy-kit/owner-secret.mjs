import { assert, identifier } from './validation.mjs';
import { activeWorker, deployedFingerprint } from './worker.mjs';
import { readOwnerState, writeOwnerState, withStateLock, withScopeHints, sameDeployment, refuse, recordSecretChange, settlePendingSecret } from './owner.mjs';

/** Set (`value` given) or remove one Worker secret of the owner's last deployment, then
 * record the Worker version the change made in the state file, so the next deploy
 * recognises its own Worker. A Worker someone else replaced is refused untouched.
 * The change is recorded as pending first: if the provider applies it but rer never
 * sees it settle, a later run adopts it (see settlePendingSecret). A change the provider
 * answered with an error clears the pending record. The secret listing
 * and active deployment lag a change, so they are read until they show it, up to `windowMs`.
 * A removed declared secret is retired: later plans omit it until it is set again. */
export async function ownerSecret({api: provider, target, statePath, binding, value, windowMs = 30000, clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const api = withScopeHints(provider);
  assert(identifier(binding), 'invalid-secret-name');
  assert(value === undefined || typeof value === 'string' && value.trim(), `missing-secret-${binding}`);
  return withStateLock(statePath, async () => {
    const state = await readOwnerState(statePath, target);
    assert(state.receipt && !state.pendingUpload, 'missing-owner-receipt');
    if (await settlePendingSecret(api, target.worker, state)) await writeOwnerState(statePath, state);
    const live = await activeWorker(api, target.worker);
    if (!live) throw refuse('owned-resource-missing', 'worker', target.worker);
    if (!sameDeployment(live, state.receipt.provider)) throw refuse('owned-resource-replaced', 'worker', target.worker);
    const path = `/workers/scripts/${target.worker}/secrets`, present = value !== undefined;
    const names = async () => { const rows = await api.request(path); assert(Array.isArray(rows), 'invalid-secret-list'); return rows.map(row => row.name); };
    const changed = present || (await names()).includes(binding);
    state.pendingSecret = {binding, present}; await writeOwnerState(statePath, state);
    try {
      if (present) await api.request(path, {method:'PUT', body:{name:binding, text:value, type:'secret_text'}});
      else if (changed) await api.request(`${path}/${binding}`, {method:'DELETE'});
    } catch (error) {
      // The provider answered and refused: nothing changed, so nothing is pending. Only a lost
      // response (no answer at all) may have applied the change.
      if (error.status !== undefined) { delete state.pendingSecret; await writeOwnerState(statePath, state); }
      throw error;
    }
    let current;
    for (const start = clock(); ; await sleep(2000)) {
      current = await activeWorker(api, target.worker);
      if (current && (!changed || !sameDeployment(current, live)) && (await names()).includes(binding) === present) break;
      if (clock() - start + 2000 > windowMs) throw new Error('secret-change-unsettled');
    }
    // A secret change makes a new version of the same code: the script and build fingerprint must not move.
    assert(current.etag === live.etag && deployedFingerprint(current.settings) === deployedFingerprint(live.settings), 'secret-change-drift');
    recordSecretChange(state, current, {binding, present});
    await writeOwnerState(statePath, state);
    return {worker:target.worker, binding, present, versionId:current.versionId};
  });
}
