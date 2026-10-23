import { randomBytes } from 'node:crypto';
import { assert, identifier } from './validation.mjs';
import { activeWorker } from './worker.mjs';
import { secretNames, validSecretNames } from './owner-secret-names.mjs';
import { waitHealth } from './health-request.mjs';
import { definiteProviderRefusal } from './provider.mjs';
import { readOwnerState, writeOwnerState, withStateLock, withScopeHints, sameDeployment, refuse, recordSecretChange, settlePendingSecret, pendingSecrets, servedBindings, liveBindings } from './owner.mjs';
import { uploadSecretCopy, deploySecretCopy } from './owner-secret-copy.mjs';
import { recordedNames } from './ai.mjs';
import { admit } from '../ai/native/names.mjs';

/** Set (each `value` given) or remove Worker secrets of the owner's last deployment as one
 * new Worker version, then record that version in the state file, so the next deploy
 * recognises its own Worker. A Worker someone else replaced is refused untouched.
 * One secret uses Cloudflare's secret call; several are one copy of the live version
 * (owner-secret-copy.mjs). Every change sets all its secrets or removes all of them.
 * The change is recorded as pending first: if the provider applies it but rer never
 * sees it settle, a later run can recognise its immediate successor (see settlePendingSecret).
 * Both success and ambiguous failure read back for up to `windowMs`. An explicit refusal
 * clears the pending record. An accepted write keeps its intent until confirmed.
 * An ambiguous failure clears it only when readback corroborates that the receipt's
 * deployment is still live. An ambiguous one-secret rotation
 * re-PUTs the value before accepting its successor as proof of the rotation.
 * A removed declared secret is retired: later plans omit it until it is set again.
 * The new version keeps everything the Worker serves but the changed secrets, so the recorded
 * deployment's runtime names admit what this change and a pending one leave on it (a change
 * carries its declared `environment` source and `optional` flag when known) and what the live
 * Worker serves, read back without a lock, before the lock; and the live Worker again under it,
 * before any recovery, key custody, intent or provider write. */
export async function ownerSecret({api: provider, target, statePath, changes, fetch = globalThis.fetch, healthOptions = {}, windowMs = 30000, clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), beforeWrite = async () => {}}) {
  const api = withScopeHints(provider);
  const bindings = changes.map(change => change.binding), present = changes[0]?.value !== undefined;
  assert(bindings.length && bindings.every(identifier) && validSecretNames(bindings), 'invalid-secret-name');
  assert(changes.every(change => (change.value !== undefined) === present), 'mixed-secret-change');
  for (const {binding, value} of changes) assert(value === undefined || typeof value === 'string' && value.trim(), `missing-secret-${binding}`);
  const recorded = await readOwnerState(statePath, target);
  if (recorded.receipt) {
    const runtime = recordedNames(recorded.receipt, target);
    anticipate(runtime, recorded, changes, present);
    admit(runtime, (await liveBindings(api, target.worker, recorded)).filter(row => present || !bindings.includes(row.name)));
  }
  return withStateLock(statePath, async () => {
    const state = await readOwnerState(statePath, target);
    assert(state.receipt && !state.pendingUpload, 'missing-owner-receipt');
    const runtime = recordedNames(state.receipt, target);
    anticipate(runtime, state, changes, present);
    const keep = live => admit(runtime, servedBindings(live).filter(row => present || !bindings.includes(row.name)));
    // A copy uploaded but never deployed is that earlier change: finish it first.
    const deployCopy = version => deploySecretCopy(api, target.worker, version, runtime);
    if (await settlePendingSecret(api, target.worker, state, {preflight:true, deployCopy, keep})) await writeOwnerState(statePath, state);
    const live = await activeWorker(api, target.worker);
    if (!live) throw refuse('owned-resource-missing', 'worker', target.worker);
    if (!sameDeployment(live, state.receipt.provider)) throw refuse('owned-resource-replaced', 'worker', target.worker);
    assert(!state.pendingSecret, 'secret-change-unsettled');
    const path = `/workers/scripts/${target.worker}/secrets`;
    const names = secretNames(await api.request(path));
    assert(names, 'invalid-secret-list');
    // The new version inherits every other binding and secret the Worker serves.
    keep(live);
    admit(runtime, [...names.filter(name => !bindings.includes(name)).map(name => ({type:'secret_text', name})), ...(present ? changes.map(secret) : [])]);
    // Removing secrets the Worker does not hold changes nothing; the rest of a removal still runs.
    const writes = present ? changes : changes.filter(change => names.includes(change.binding));
    const existed = writes.some(change => names.includes(change.binding)), changed = writes.length > 0, copy = writes.length > 1;
    await beforeWrite();
    state.pendingSecret = {bindings, present, versionId:state.receipt.provider.versionId, names:names.filter(name => !bindings.includes(name)).sort(), ...(copy ? {copy:randomBytes(16).toString('hex')} : {})};
    await writeOwnerState(statePath, state);
    let failure, unchanged = false, confirming = false, uploaded = false;
    const put = () => api.request(path, {method:'PUT', body:{name:writes[0].binding, text:writes[0].value, type:'secret_text'}});
    try {
      if (copy) {
        const version = await uploadSecretCopy(api, target.worker, live, {changes:writes, marker:state.pendingSecret.copy});
        uploaded = true;
        await deploySecretCopy(api, target.worker, version, runtime);
      }
      else if (present) await put();
      else if (changed) await api.request(`${path}/${writes[0].binding}`, {method:'DELETE'});
    } catch (error) {
      // A refused upload changed nothing. A copy uploaded but refused deployment stays
      // pending: the same command deploys it next time, as this change and no other.
      if (definiteProviderRefusal(error) && !uploaded) { delete state.pendingSecret; await writeOwnerState(statePath, state); throw error; }
      if (definiteProviderRefusal(error)) { await writeOwnerState(statePath, state); throw error; }
      failure = error;
    }
    try {
      if (!changed) recordSecretChange(state, live, state.pendingSecret);
      else for (const start = clock(); ; await sleep(2000)) {
        try {
          if (await settlePendingSecret(api, target.worker, state, {keep,
            observe: current => { unchanged = sameDeployment(current, state.receipt.provider); },
            // A copy whose upload or deployment answer was lost is deployed here once it is found.
            ...(copy ? {deployCopy} : {}),
            ...(failure && present && existed && !copy ? {confirm: async current => {
              confirming = true;
              state.pendingSecret.repeatVersionId = current.versionId;
              await writeOwnerState(statePath, state);
              await put();
              confirming = false;
            }} : {})
          })) break;
        }
        catch (error) {
          unchanged = false;
          // Another ambiguous PUT cannot prove a rotation by presence either.
          // Keep both starting versions for recovery; do not report it done.
          if (confirming) throw error;
          if (error.message !== 'provider-transport-failed' && !(error.status >= 500 && error.status < 600)) throw error;
        }
        if (clock() - start + 2000 > windowMs) throw failure ?? new Error('secret-change-unsettled');
      }
    } catch (error) {
      if (unchanged && failure) delete state.pendingSecret;
      await writeOwnerState(statePath, state);
      throw failure ?? error;
    }
    const result = {worker:target.worker, bindings, present, versionId:state.receipt.provider.versionId};
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

const secret = change => ({type:'secret_text', name:change.binding, environment:change.environment, optional:change.optional === true});
/** What a pending change and this one leave on the Worker: a several-secret copy a recovery may
 * still deploy passes on its own; other set secrets stay unless this change removes them. */
function anticipate(runtime, state, changes, present) {
  const pending = pendingSecrets(state), named = changes.map(change => change.binding);
  if (state.pendingSecret?.copy) admit(runtime, pending);
  admit(runtime, [...pending.filter(row => present || !named.includes(row.name)), ...(present ? changes.map(secret) : [])]);
}
