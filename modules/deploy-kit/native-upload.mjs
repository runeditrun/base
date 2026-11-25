import { pause } from './cancellation.mjs';
import { assert } from './validation.mjs';
import { activeWorker } from './worker.mjs';
import { beginUpload, carriesUpload, checkOwnedWorker, deploymentIdentity, readOwnerState, sameDeployment, uploadMessage, withScopeHints, withSettledLists, withStateLock, writeOwnerState } from './owner.mjs';
import { workerReplacementRecovery } from './owner-settings.mjs';

/* Native deploy adapters upload the Worker with their own tool (a seed's Wrangler run) and keep
 * rer's ownership record (owner.mjs). They get the same pending-upload reconciliation as rer's own
 * deploys: the build fingerprint is recorded before the upload; the upload is recorded as this
 * deployment's own as soon as the live version carries both marks (RER_DEPLOY_FINGERPRINT and the
 * version message `rer-deploy:<fingerprint>`), even when a later step of the same tool (queue
 * consumers, triggers) fails; and a retry or `ownerRemove` adopts exactly that upload. A Worker
 * without both marks, or deployed by someone else, is still refused. */

const defaults = {deploy:'the same deploy command', remove:"this environment's removal command"};

/** Operator text for an ownership refusal from a native deploy or removal: what was found and what
 * to run next. Errors that are not ownership refusals return null. */
export function ownershipMessage(error, commands = {}) {
  const {deploy, remove} = {...defaults, ...commands};
  const [kind, name] = String(error?.resource ?? '').split(/:(.*)/s);
  const seen = error?.observed ?? {};
  if (kind === 'worker') switch (error.message) {
    case 'resource-name-collision':
      return `Worker ${name} already exists in this Cloudflare account, but this deployment record never started creating it, so rer changed nothing and will not adopt or remove it. Use another environment name, or delete that Worker in Cloudflare if nobody uses it, then run ${deploy} again.`;
    case 'uncertain-resource-create':
      if (seen.pending && seen.fingerprint === seen.pending) return `Worker ${name} runs the build this deployment record started uploading (RER_DEPLOY_FINGERPRINT ${seen.pending}), but its version lacks the message ${uploadMessage(seen.pending)}, so rer cannot prove this checkout uploaded it: the uploader did not set that message. rer changed nothing. If Cloudflare shows this Worker created at the failed attempt with a single version, delete that one Worker in Cloudflare (Workers & Pages, or DELETE /accounts/<account>/workers/scripts/${name} without force), keep this deployment record and its data resources, then run ${deploy} again.`;
      return `Worker ${name} exists, but its live version carries neither this record's confirmed identity nor the marks of the upload the record started (RER_DEPLOY_FINGERPRINT ${seen.pending ?? 'not recorded'} with version message ${seen.pending ? uploadMessage(seen.pending) : 'rer-deploy:<fingerprint>'}), so rer cannot prove it is this deployment's Worker and changed nothing. If another checkout deployed this environment, run its deploy from that checkout. Otherwise inspect the Worker in Cloudflare; if nobody uses it, delete it there and run ${deploy} again.`;
    case 'owned-resource-replaced':
      return `rer could not verify ownership of Worker ${name} (live version ${seen.versionId ?? 'unknown'}, recorded ${seen.expected ?? 'unknown'}). ${workerReplacementRecovery(deploy)}`;
    case 'owned-resource-missing':
      return `Worker ${name} is recorded as created, but Cloudflare no longer has it. To finish removing this environment, run ${remove}: it permanently deletes the remaining recorded resources and their data, including any database and files. rer does not redeploy over a recorded Worker that disappeared.`;
  }
  if (error?.message === 'unrecorded-resource') return `${error.resource} exists under this environment's name but is not in this deployment record, so rer did not remove anything. Run ${remove} from the checkout whose record created it, or delete it in Cloudflare yourself if it is not in use.`;
  if (error?.message === 'owned-resource-replaced') return `${error.resource} is no longer the resource this record created (its identity changed), so rer changed nothing. Inspect it in Cloudflare; keep any data you need, and use another environment name if someone else uses it.`;
  if (error?.message === 'uncertain-resource-create') return `${error.resource} was being created when an earlier run stopped, and its creation was never confirmed, so rer will not adopt or delete it. Inspect it in Cloudflare: if it is the empty one from that run, delete it there, then run ${deploy} or ${remove} again.`;
  return null;
}

function explained(error, commands) {
  const text = ownershipMessage(error, commands);
  return text ? Object.assign(new Error(text, {cause:error}), {code:error.message, resource:error.resource}) : error;
}

/** Read-only for the provider: the live Worker this record owns (null when absent), adopting an
 * interrupted upload or a verified settings-only change. Run it before provisioning anything. */
export async function nativeWorkerCheck({api: provider, target, statePath, commands, signal, notice = console.error}) {
  const api = withSettledLists(withScopeHints(provider), {signal});
  assert(target?.accountId === api.accountId, 'owner-account-mismatch');
  return withStateLock(statePath, async () => {
    const state = await readOwnerState(statePath, target);
    try { return await checkOwnedWorker(api, target.worker, state, () => writeOwnerState(statePath, state), {adoptSettings:true,notice}); }
    catch (error) { throw explained(error, commands); }
  });
}

/** Cloudflare can serve a new version before its own version read finds it (404).
 * That read waits; any other provider error fails. */
async function readLive(api, worker) {
  try { return await activeWorker(api, worker); }
  catch (error) { if (error.status === 404 && error.providerCall?.operation?.includes('/versions/')) return undefined; throw error; }
}

/** After a successful upload, a fresh version carrying both marks must become active. The prior
 * version stays acceptable only while it is still active; any other version is drift. */
async function uploadedVersion(api, worker, pending, {waitMs, clock, sleep, signal}) {
  const start = clock();
  for (let delay = 500; ; delay = Math.min(delay * 2, 4000)) {
    const live = await readLive(api, worker);
    const prior = live && pending.previous && sameDeployment(live, pending.previous);
    if (live && !prior && carriesUpload(live, pending.fingerprint)) return live;
    if (live && !prior) throw Object.assign(new Error('owned-resource-replaced'), {resource:`worker:${worker}`, observed:{versionId:live.versionId, expected:'this upload'}});
    if (clock() - start + delay > waitMs) return null;
    await pause(delay, signal, sleep);
  }
}

/** Run a native adapter's Worker upload under the ownership record's lock.
 * `upload` performs the upload with both marks for `fingerprint`; `receipt` holds the adapter's own
 * receipt fields (origin, source). A failure after the upload landed leaves it recorded as this
 * deployment's own, so running the same deploy again adopts it and repeats only what the record
 * does not show as done; `ownerRemove` removes it. Returns the completed receipt. */
export async function nativeUpload({api: provider, target, statePath, fingerprint, receipt = {}, upload, commands, readbackMs = 60000, clock = () => performance.now(), sleep, signal, notice = console.error}) {
  assert(typeof fingerprint === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(fingerprint), 'invalid-upload-fingerprint');
  assert(typeof upload === 'function', 'missing-native-upload');
  const {deploy, remove} = {...defaults, ...commands};
  const api = withSettledLists(withScopeHints(provider), {signal});
  assert(target?.accountId === api.accountId, 'owner-account-mismatch');
  return withStateLock(statePath, async () => {
    const state = await readOwnerState(statePath, target);
    const save = () => writeOwnerState(statePath, state);
    let prior;
    try { prior = await checkOwnedWorker(api, target.worker, state, save, {adoptSettings:true,notice}); }
    catch (error) { throw explained(error, commands); }
    state.owned.worker ??= {status:'pending'};
    beginUpload(state, fingerprint, prior); await save();
    let failure;
    try { await upload(); } catch (error) { failure = error; }
    let live = null;
    if (failure) {
      // One read: record the upload if it already landed. A retry reconciles a later one.
      try {
        const current = await readLive(api, target.worker);
        const priorActive = current && prior && sameDeployment(current, prior);
        if (current && !priorActive && carriesUpload(current, fingerprint)) live = current;
      } catch { /* The retry's own identity check reads it again. */ }
    } else {
      try { live = await uploadedVersion(api, target.worker, state.pendingUpload, {waitMs:readbackMs, clock, sleep, signal}); }
      catch (error) { throw explained(error, commands); }
    }
    if (live) { state.pendingUpload.provider = deploymentIdentity(live); state.owned.worker = {status:'created'}; await save(); }
    if (failure) {
      const removal = state.receipt ? '' : ` To remove this deployment and permanently delete its recorded data, including any database and files, run ${remove}.`;
      const next = live
        ? `The upload of Worker ${target.worker} is recorded as this deployment's own (version ${live.versionId}); a later step did not finish. Run ${deploy} again: it adopts this upload and repeats the steps that did not finish.${removal}`
        : `Cloudflare did not show this attempt's upload of Worker ${target.worker}, so nothing new was recorded. Run ${deploy} again: if the upload landed, it is adopted once its version carries ${uploadMessage(fingerprint)}; otherwise it uploads again.`;
      throw Object.assign(new Error(`${failure.message}\n${next}`, {cause:failure}), {code:'native-upload-incomplete', uploadRecorded:Boolean(live)});
    }
    if (!live) throw Object.assign(new Error(`Worker ${target.worker} did not report this upload (RER_DEPLOY_FINGERPRINT ${fingerprint} with version message ${uploadMessage(fingerprint)}) within ${Math.round(readbackMs / 1000)} seconds. Check that the uploader sets both, then run ${deploy} again: a landed upload is adopted then.`), {code:'native-upload-unconfirmed'});
    state.receipt = {...receipt, fingerprint, provider:deploymentIdentity(live)};
    delete state.pendingUpload;
    await save();
    return state.receipt;
  });
}
