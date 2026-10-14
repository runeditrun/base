import { assert, identifier } from './validation.mjs';
import { activeWorker } from './worker.mjs';
import { waitHealth } from './health-request.mjs';
import { definiteProviderRefusal } from './provider.mjs';
import { readOwnerState, writeOwnerState, withStateLock, withScopeHints, sameDeployment, refuse, recordSecretChange, settlePendingSecret } from './owner.mjs';

/** Set (`value` given) or remove one Worker secret of the owner's last deployment, then
 * record the Worker version the change made in the state file, so the next deploy
 * recognises its own Worker. A Worker someone else replaced is refused untouched.
 * The change is recorded as pending first: if the provider applies it but rer never
 * sees it settle, a later run can recognise its immediate successor (see settlePendingSecret).
 * Both success and ambiguous failure read back for up to `windowMs`. An explicit refusal,
 * or an outcome not confirmed in that window, clears the pending record.
 * A removed declared secret is retired: later plans omit it until it is set again. */
export async function ownerSecret({api: provider, target, statePath, binding, value, fetch = globalThis.fetch, healthOptions = {}, windowMs = 30000, clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
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
    state.pendingSecret = {binding, present, versionId:state.receipt.provider.versionId}; await writeOwnerState(statePath, state);
    let failure;
    try {
      if (present) await api.request(path, {method:'PUT', body:{name:binding, text:value, type:'secret_text'}});
      else if (changed) await api.request(`${path}/${binding}`, {method:'DELETE'});
    } catch (error) {
      if (definiteProviderRefusal(error)) { delete state.pendingSecret; await writeOwnerState(statePath, state); throw error; }
      failure = error;
    }
    try {
      if (!changed) recordSecretChange(state, live, state.pendingSecret);
      else for (const start = clock(); ; await sleep(2000)) {
        try { if (await settlePendingSecret(api, target.worker, state)) break; }
        catch (error) {
          if (error.message !== 'provider-transport-failed' && !(error.status >= 500 && error.status < 600)) throw error;
        }
        if (clock() - start + 2000 > windowMs) throw failure ?? new Error('secret-change-unsettled');
      }
    } catch (error) {
      delete state.pendingSecret; await writeOwnerState(statePath, state);
      throw failure ?? error;
    }
    const result = {worker:target.worker, binding, present, versionId:state.receipt.provider.versionId};
    // Settlement is durable before readiness: a failed hosted check must never
    // erase the applied mutation or cause the next command to reject our version.
    state.receipt.health = {ok:false,versionId:result.versionId};
    await writeOwnerState(statePath, state);
    try {
      if (state.receipt.origin) await waitHealth({
        origin:state.receipt.origin, receipt:state.receipt, versionId:result.versionId, request:fetch,
        timeoutMs:healthOptions.timeoutMs,
        clock:healthOptions.now, sleep:healthOptions.sleep, ...healthOptions.readiness,
      });
      const after = await activeWorker(api, target.worker);
      assert(after && sameDeployment(after, state.receipt.provider), 'deployment-changed-during-health');
      // Response prefixes belong only in the caller's redacted diagnostic, never
      // in the ownership record: an unhealthy app may accidentally echo a secret.
      state.receipt.health = {ok:true,versionId:result.versionId};
      await writeOwnerState(statePath, state);
      return result;
    } catch (error) {
      error.secretChange = result;
      throw error;
    }
  });
}
